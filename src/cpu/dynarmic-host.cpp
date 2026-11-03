// Standalone Dynarmic CPU: execution, privileged state and sparse physical
// memory.
#include "dynarmic-system.h"
#include "dynarmic/backend/wasm/a32_interface.h"
#include "dynarmic/backend/wasm/abi.h"
#include "dynarmic/frontend/A32/a32_ir_emitter.h"
#include "dynarmic/interface/A32/a32.h"
#include "dynarmic/interface/exclusive_monitor.h"
#include "dynarmic/ir/terminal.h"
#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <memory>
#include <unordered_set>
#include <vector>
using namespace Dynarmic;
using U32 = uint32_t;
using U64 = uint64_t;
using Callback = int (*)(U32, U32, U32, U64);
using Clock = void (*)(U64, U32);
struct Hook {
  U32 id, kind, begin, end;
  U32 action = 0;
  bool matches(U32 a) const { return begin > end || (a >= begin && a <= end); }
};
constexpr U64 Never = ~U64(0);
// Stable CpuBackend error codes, shared with backend.ts.
enum Error : U32 {
  Ok = 0,
  NoMemory = 1,
  ReadUnmapped = 6,
  WriteUnmapped = 7,
  FetchUnmapped = 8,
  InvalidInstruction = 10,
  MapOverlap = 11,
  WriteProtected = 12,
  ReadProtected = 13,
  FetchProtected = 14,
  InvalidArgument = 15
};
#include "native-compose.h"
struct Host final : A32::UserCallbacks {
  ArmSystem sys;
  U64 irq_count = 0, undefined_count = 0, division_count = 0;
  U32 undefined_pc = 0;
#ifdef XHALF_PROFILE_HOOKS
  // Alternating checks/hits for each HookKind, per CPU instance. Counter-only:
  // no addresses, firmware bytes, timestamps or per-block JavaScript calls.
  std::array<U64, 14> hook_profile{};
#endif
  Callback callback;
  Clock clock = nullptr;
  ExclusiveMonitor monitor{1};
  std::unique_ptr<A32::Jit> jit;
  std::array<uint8_t *, 1 << 20> pages{}, fast{};
  std::array<uint8_t, 1 << 20> perms{};
  struct Allocation {
    uint8_t *data;
    U32 live_pages;
  };
  std::vector<Allocation> allocations;
  std::vector<U32> free_allocations;
  std::array<U32, 1 << 20> owners{};
  std::vector<Hook> hooks;
  U32 next = 1, budget = 0, charged = 0, until = 0, unit = 2, freq = 27000000,
      levels = 0, error = 0;
  U64 now = 0, ticks = 0, remainder = 0, deadline = Never, jit_count = 0,
      slow_count = 0;
  bool stopped = false, irq = false, exact = false, pending = false,
       redispatch = false, native_redirect = false;
  U32 pending_pc = 0;
  // A conservative fixed filter for code/block hooks. Address collisions only
  // cause extra exact checks; they never invoke a callback by themselves.
  static constexpr U32 HookSlots = 1 << 16;
  std::array<uint8_t, HookSlots> instruction_hook_slots{};
  uint8_t global_instruction_hooks = 0;
  Backend::Wasm::BoundaryState boundary{};
  std::unordered_set<U32> code_points, block_points;
  std::vector<Hook> code_ranges, block_ranges;
  explicit Host(Callback cb) : callback(cb) {
    boundary.hook_slots = static_cast<U32>(
        reinterpret_cast<uintptr_t>(instruction_hook_slots.data()));
    A32::UserConfig c;
    c.callbacks = this;
    c.global_monitor = &monitor;
    c.page_table = &fast;
    c.enable_cycle_counting = true;
    c.hook_hint_instructions = true;
    c.arch_version = A32::ArchVersion::v8;
    jit = Backend::Wasm::CreateA32Jit(
        c, &boundary, true,
        {[](void *user) { static_cast<Host *>(user)->after_ticks(); }, this});
    jit->SetCpsr(0x400001d3);
  }
  ~Host() {
    jit.reset();
    for (auto &a : allocations)
      free(a.data);
  }
  void request_boundary() {
    boundary.flags |= Backend::Wasm::kBoundaryDisableRegions;
  }
  void index_hooks() {
    instruction_hook_slots.fill(0);
    global_instruction_hooks = 0;
    bool local_instruction_hooks = false;
    code_points.clear();
    block_points.clear();
    code_ranges.clear();
    block_ranges.clear();
    for (auto &h : hooks) {
      if (h.kind == 1 || h.kind == 2) {
        const uint8_t mask = 1u << h.kind;
        const U32 first = h.begin >> 1, last = h.end >> 1;
        // Thumb and ARM instruction addresses are at least halfword-aligned;
        // odd range endpoints conservatively share their enclosing slot.
        if (h.begin > h.end || U64(last) - first + 1 >= HookSlots)
          global_instruction_hooks |= mask;
        else {
          local_instruction_hooks = true;
          for (U32 slot = first; slot <= last; slot++)
            instruction_hook_slots[slot & (HookSlots - 1)] |= mask;
        }
      }
      if (h.kind == 1) {
        if (h.begin == h.end)
          code_points.insert(h.begin);
        else
          code_ranges.push_back(h);
      }
      if (h.kind == 2) {
        if (h.begin == h.end)
          block_points.insert(h.begin);
        else
          block_ranges.push_back(h);
      }
    }
    boundary.instruction_hooks =
        global_instruction_hooks | (local_instruction_hooks ? 1 : 0);
    request_boundary();
  }
  bool interested(U32 k, U32 a) {
#ifdef XHALF_PROFILE_HOOKS
    hook_profile[k * 2]++;
    const bool hit = matches_hook(k, a);
    hook_profile[k * 2 + 1] += hit;
    return hit;
#else
    return matches_hook(k, a);
#endif
  }
  bool matches_hook(U32 k, U32 a) {
    if (k == 1 || k == 2) {
      if (!((instruction_hook_slots[(a >> 1) & (HookSlots - 1)] |
             global_instruction_hooks) &
            (1u << k)))
        return false;
      auto &points = k == 1 ? code_points : block_points;
      if (points.contains(a))
        return true;
      auto &ranges = k == 1 ? code_ranges : block_ranges;
      for (auto &h : ranges)
        if (h.matches(a))
          return true;
      return false;
    }
    for (auto &h : hooks)
      if (h.kind == k && h.matches(a))
        return true;
    return false;
  }

  void emit(U32 k, U32 a, U32 n, U64 v = 0) {
    if (k != 1) {
      callback(k, a, n, v);
      return;
    }
    U32 action = 0;
    bool observable = false;
    for (const auto &h : hooks)
      if (h.kind == k && h.matches(a)) {
        if (h.action)
          action = h.action;
        else
          observable = true;
      }
    if (observable)
      callback(k, a, n, v);
    if (action && !stopped && jit->Regs()[15] == a) {
      auto &r = jit->Regs();
      const U32 numerator = r[0], denominator = r[1];
      r[0] = denominator ? numerator / denominator : (numerator ? ~U32(0) : 0);
      if (action == 2)
        r[1] = denominator ? numerator % denominator : 0;
      r[15] = r[14];
      division_count++;
      native_redirect = true;
    }
  }
  void fault(U32 a, U32 access) {
    error = access == 19   ? ReadUnmapped
            : access == 20 ? WriteUnmapped
            : access == 21 ? FetchUnmapped
                           : access;
    stopped = true;
    jit->HaltExecution();
    emit(7, a, error);
  }
  bool valid(U32 a, U32 n, U32 permission) {
    if (error)
      return false;
    if (U64(a) + n > 0x100000000ull) {
      fault(a, 21);
      return false;
    }
    for (U64 p = a >> 12; p <= (U64(a) + n - 1) / 4096; p++) {
      if (!pages[p])
        emit(5, a, n, permission == 1 ? 19 : permission == 2 ? 20 : 21);
      if (!pages[p] || !(perms[p] & permission)) {
        fault(a, !pages[p] ? (permission == 1   ? 19
                              : permission == 2 ? 20
                                                : 21)
                           : (permission == 1   ? ReadProtected
                              : permission == 2 ? WriteProtected
                                                : FetchProtected));
        return false;
      }
    }
    return true;
  }
  U64 read(U32 a, U32 n, bool code = false) {
    if (!valid(a, n, code ? 4 : 1))
      return 0;
    if (!code && interested(3, a))
      emit(3, a, n);
    U64 v = 0;
    for (U32 i = 0; i < n; i++)
      v |= U64(pages[(a + i) >> 12][(a + i) & 4095]) << (8 * i);
    return v;
  }
  void write(U32 a, U32 n, U64 v) {
    if (!valid(a, n, 2))
      return;
    if (interested(4, a))
      emit(4, a, n, v);
    for (U32 i = 0; i < n; i++)
      pages[(a + i) >> 12][(a + i) & 4095] = v >> (8 * i);
  }
  void refresh(U32 first = 0, U32 last = 1 << 20) {
    for (U32 p = first; p < last; p++) {
      bool observed = false;
      for (const auto &h : hooks)
        if ((h.kind == 3 || h.kind == 4) &&
            (h.begin > h.end ||
             (U64(h.begin) < U64(p + 1) * 4096 && h.end >= p * 4096))) {
          observed = true;
          break;
        }
      fast[p] = !observed && (perms[p] & 3) == 3 ? pages[p] : nullptr;
    }
  }
  bool range(U32 a, U64 n, bool aligned = false) const {
    return n && U64(a) + n <= 0x100000000ull && (!aligned || !((a | n) & 4095));
  }
  bool mapped(U32 a, U64 n) const {
    for (U64 p = a >> 12; p < (U64(a) + n + 4095) / 4096; p++)
      if (!pages[p])
        return false;
    return true;
  }
  U32 map(U32 a, U32 n, U32 perm) {
    if (!range(a, n, true) || perm > 7)
      return InvalidArgument;
    for (U64 p = a >> 12; p < (U64(a) + n) / 4096; p++)
      if (pages[p])
        return MapOverlap;
    auto *data = static_cast<uint8_t *>(calloc(n, 1));
    if (!data)
      return NoMemory;
    U32 owner;
    if (free_allocations.empty()) {
      owner = allocations.size();
      allocations.push_back({data, n / 4096});
    } else {
      owner = free_allocations.back();
      free_allocations.pop_back();
      allocations[owner] = {data, n / 4096};
    }
    for (U64 i = 0; i < n; i += 4096) {
      pages[(a + i) >> 12] = data + i;
      perms[(a + i) >> 12] = perm;
      owners[(a + i) >> 12] = owner;
    }
    refresh(a >> 12, (U64(a) + n) / 4096);
    return Ok;
  }
  U32 unmap(U32 a, U32 n) {
    if (!range(a, n, true))
      return InvalidArgument;
    if (!mapped(a, n))
      return MapOverlap;
    for (U64 p = a >> 12; p < (U64(a) + n) / 4096; p++) {
      auto &allocation = allocations[owners[p]];
      if (!--allocation.live_pages) {
        free(allocation.data);
        allocation.data = nullptr;
        free_allocations.push_back(owners[p]);
      }
      pages[p] = fast[p] = nullptr;
      perms[p] = 0;
    }
    jit->InvalidateCacheRange(a, n);
    return Ok;
  }
  U32 protect(U32 a, U32 n, U32 perm) {
    if (!range(a, n, true) || perm > 7)
      return InvalidArgument;
    if (!mapped(a, n))
      return MapOverlap;
    for (U64 p = a >> 12; p < (U64(a) + n) / 4096; p++)
      perms[p] = perm;
    refresh(a >> 12, (U64(a) + n) / 4096);
    jit->InvalidateCacheRange(a, n);
    return Ok;
  }
  // Host transfers deliberately bypass guest permissions and observers. Loading
  // code and servicing MMIO must not recursively trigger guest memory hooks.
  U32 transfer(U32 a, U32 n, uint8_t *buffer, bool write) {
    if (!n)
      return Ok;
    if (!range(a, n))
      return InvalidArgument;
    if (!mapped(a, n))
      return write ? WriteUnmapped : ReadUnmapped;
    U64 end = U64(a) + n;
    for (U64 at = a; at < end;) {
      U32 count = std::min<U64>(4096 - (at & 4095), end - at);
      auto *page = pages[at >> 12] + (at & 4095);
      if (write)
        memcpy(page, buffer, count);
      else
        memcpy(buffer, page, count);
      buffer += count;
      at += count;
    }
    return Ok;
  }
  // Return direct memory only when every page belongs to one contiguous native
  // allocation. The caller uses it synchronously while guest execution is
  // paused; fragmented mappings retain the copying transfer path.
  U32 view(U32 a, U32 n, uint8_t **buffer) {
    *buffer = nullptr;
    if (!n)
      return Ok;
    if (!range(a, n))
      return InvalidArgument;
    if (!mapped(a, n))
      return ReadUnmapped;
    const U64 first = a >> 12, last = (U64(a) + n - 1) >> 12;
    for (U64 p = first + 1; p <= last; p++)
      if (pages[p] != pages[p - 1] + 4096)
        return Ok;
    *buffer = pages[first] + (a & 4095);
    return Ok;
  }
  U32 copy(U32 destination, U32 source, U32 n) {
    if (!n)
      return Ok;
    if (!range(source, n) || !range(destination, n))
      return InvalidArgument;
    if (!mapped(source, n))
      return ReadUnmapped;
    if (!mapped(destination, n))
      return WriteUnmapped;
    uint8_t *from, *to;
    view(source, n, &from);
    view(destination, n, &to);
    if (from && to) {
      memmove(to, from, n);
      return Ok;
    }
    // Fragmented mappings and overlapping ranges retain an exact snapshot.
    std::unique_ptr<uint8_t, decltype(&free)> temporary(
        static_cast<uint8_t *>(malloc(n)), &free);
    if (!temporary)
      return NoMemory;
    transfer(source, n, temporary.get(), false);
    return transfer(destination, n, temporary.get(), true);
  }
  U32 fill(U32 a, U32 n, uint8_t value) {
    if (!n)
      return Ok;
    if (!range(a, n))
      return InvalidArgument;
    if (!mapped(a, n))
      return WriteUnmapped;
    const U64 end = U64(a) + n;
    for (U64 at = a; at < end;) {
      const U32 count = std::min<U64>(4096 - (at & 4095), end - at);
      memset(pages[at >> 12] + (at & 4095), value, count);
      at += count;
    }
    return Ok;
  }
  U32 compose4(const NativeComposeSurface *surface,
               const NativeComposeLayer *layers, U32 count) {
    return nativeCompose4(*this, surface, layers, count);
  }
  std::optional<U32> MemoryReadCode(U32 a) override {
    if (!valid(a, 4, 4))
      return std::nullopt;
    return U32(read(a, 4, true));
  }
  uint8_t MemoryRead8(U32 a) override { return read(a, 1); }
  uint16_t MemoryRead16(U32 a) override { return read(a, 2); }
  U32 MemoryRead32(U32 a) override { return read(a, 4); }
  U64 MemoryRead64(U32 a) override { return read(a, 8); }
  void MemoryWrite8(U32 a, uint8_t v) override { write(a, 1, v); }
  void MemoryWrite16(U32 a, uint16_t v) override { write(a, 2, v); }
  void MemoryWrite32(U32 a, U32 v) override { write(a, 4, v); }
  void MemoryWrite64(U32 a, U64 v) override { write(a, 8, v); }
  bool MemoryWriteExclusive8(U32 a, uint8_t v, uint8_t e) override {
    if (read(a, 1) != e)
      return false;
    write(a, 1, v);
    return true;
  }
  bool MemoryWriteExclusive16(U32 a, uint16_t v, uint16_t e) override {
    if (read(a, 2) != e)
      return false;
    write(a, 2, v);
    return true;
  }
  bool MemoryWriteExclusive32(U32 a, U32 v, U32 e) override {
    if (read(a, 4) != e)
      return false;
    write(a, 4, v);
    return true;
  }
  bool MemoryWriteExclusive64(U32 a, U64 v, U64 e) override {
    if (read(a, 8) != e)
      return false;
    write(a, 8, v);
    return true;
  }
  static bool condition(U32 cond, U32 cpsr) {
    bool n = cpsr >> 31, z = (cpsr >> 30) & 1, c = (cpsr >> 29) & 1,
         v = (cpsr >> 28) & 1;
    switch (cond) {
    case 0:
      return z;
    case 1:
      return !z;
    case 2:
      return c;
    case 3:
      return !c;
    case 4:
      return n;
    case 5:
      return !n;
    case 6:
      return v;
    case 7:
      return !v;
    case 8:
      return c && !z;
    case 9:
      return !c || z;
    case 10:
      return n == v;
    case 11:
      return n != v;
    case 12:
      return !z && n == v;
    case 13:
      return z || n != v;
    default:
      return true;
    }
  }
  void undefined(U32 pc, U32 size) {
    undefined_count++;
    undefined_pc = pc;
    if (interested(0, pc)) {
      if (!callback(0, pc, size, 0)) {
        error = InvalidInstruction;
        stopped = true;
      }
      return;
    }
    sys.exception(*jit, 27, 4, pc + size, false);
  }
  void status_write(bool saved, U32 fields, U32 value) {
    U32 mask = 0;
    for (unsigned i = 0; i < 4; i++)
      if (fields & (1 << i))
        mask |= 0xffu << (i * 8);
    if (saved) {
      auto &s = sys.banks.spsr[ArmSystem::bank(jit->Cpsr())];
      s = (s & ~mask) | (value & mask);
    } else {
      // MSR cannot write execution-state bits; user mode can only write flags.
      mask &= (jit->Cpsr() & 31) == 16 ? 0xf80f0000u : 0xf80f03dfu;
      sys.set_cpsr(*jit, (jit->Cpsr() & ~mask) | (value & mask));
    }
  }
  U32 operand2(U32 x, U32 pc) {
    auto &r = jit->Regs();
    if (x & (1 << 25))
      return std::rotr(x & 255, int((x >> 8) & 15) * 2);
    unsigned m = x & 15, type = (x >> 5) & 3, shift = (x >> 7) & 31;
    U32 value = m == 15 ? pc + 8 : r[m];
    if (x & 16)
      shift = r[(x >> 8) & 15] & 255;
    if (!shift) {
      if (x & 16)
        return value;
      if (type == 0)
        return value;
      if (type == 3)
        return ((jit->Cpsr() & 0x20000000) << 2) | (value >> 1);
      shift = 32;
    }
    if (type == 0)
      return shift >= 32 ? 0 : value << shift;
    if (type == 1)
      return shift >= 32 ? 0 : value >> shift;
    if (type == 2)
      return U32(int32_t(value) >> std::min(shift, 31u));
    return std::rotr(value, int(shift & 31));
  }
  bool bank_transfer(U32 x) {
    bool saved = x & (1 << 22), load = !(x & (1 << 21));
    unsigned sysm = ((x >> 16) & 15) | ((x >> 4) & 16), m = 0, reg = 0;
    if (saved) {
      switch (sysm) {
      case 14:
        m = 17;
        break;
      case 16:
        m = 18;
        break;
      case 18:
        m = 19;
        break;
      case 20:
        m = 23;
        break;
      case 22:
        m = 27;
        break;
      case 28:
        m = 22;
        break;
      default:
        return false;
      }
      if (load)
        jit->Regs()[(x >> 12) & 15] = sys.banks.spsr[m];
      else
        sys.banks.spsr[m] = jit->Regs()[x & 15];
      return true;
    }
    if (sysm <= 6) {
      m = 16;
      reg = 8 + sysm;
    } else if (sysm >= 8 && sysm <= 14) {
      m = 17;
      reg = sysm;
    } else {
      switch (sysm & ~1u) {
      case 16:
        m = 18;
        break;
      case 18:
        m = 19;
        break;
      case 20:
        m = 23;
        break;
      case 22:
        m = 27;
        break;
      case 28:
        m = 22;
        break;
      default:
        return false;
      }
      reg = (sysm & 1) ? 13 : 14;
    }
    auto &v = sys.banked(*jit, m, reg);
    if (load)
      jit->Regs()[(x >> 12) & 15] = v;
    else
      v = jit->Regs()[x & 15];
    return true;
  }
  bool coprocessor(U32 x) {
    bool load = x & (1 << 20);
    unsigned rd = (x >> 12) & 15, rn = (x >> 16) & 15, crm = x & 15;
    if ((x & 0x0f000f10) == 0x0e000f10) {
      U32 value = jit->Regs()[rd];
      unsigned op1 = (x >> 21) & 7, op2 = (x >> 5) & 7;
      if (!sys.cp15(load, op1, rn, crm, op2, value))
        return false;
      if (load) {
        if (rd == 15)
          jit->SetCpsr((jit->Cpsr() & 0x0fffffff) | (value & 0xf0000000));
        else
          jit->Regs()[rd] = value;
      } else if (rn == 7 && crm == 5)
        jit->ClearCache();
      return true;
    }
    if ((x & 0x0fe00f00) == 0x0c400f00) {
      U64 value = U64(jit->Regs()[rd]) | (U64(jit->Regs()[rn]) << 32);
      if (!sys.cp15_pair(load, (x >> 4) & 15, crm, value))
        return false;
      if (load) {
        jit->Regs()[rd] = value;
        jit->Regs()[rn] = value >> 32;
      }
      return true;
    }
    if ((x & 0x0fef0fff) == 0x0ee80a10) {
      if (load)
        jit->Regs()[rd] = sys.banks.fpexc;
      else
        sys.banks.fpexc = jit->Regs()[rd];
      return true;
    }
    return false;
  }
  void execute_system(U32 pc) {
    auto &r = jit->Regs();
    const U32 cpsr = jit->Cpsr();
    bool thumb = cpsr & 32;
    U32 x = U32(read(pc, thumb ? 2 : 4, true)), size = 4;
    if (error)
      return;
    if (thumb) {
      size = (x & 0xf800) >= 0xe800 ? 4 : 2;
      if (size == 4)
        x = (x << 16) | U32(read(pc + 2, 2, true));
      U32 it = ((cpsr >> 25) & 3) | ((cpsr >> 8) & 0xfc);
      if (it) {
        U32 next = (it & 7) ? (it & 0xe0) | ((it << 1) & 31) : 0;
        jit->SetCpsr((cpsr & ~0x0600fc00u) | ((next & 3) << 25) |
                     ((next & 0xfc) << 8));
        if (!condition(it >> 4, cpsr)) {
          r[15] = pc + size;
          return;
        }
      }
    } else if (!condition(x >> 28, cpsr)) {
      r[15] = pc + 4;
      return;
    }
    r[15] = pc + size;
    if (thumb) {
      if (size == 2 && (x & 0xffe8) == 0xb660) {
        if ((cpsr & 31) != 16)
          sys.set_cpsr(*jit, (x & 16) ? cpsr | ((x & 7) << 6)
                                      : cpsr & ~((x & 7) << 6));
        return;
      }
      if (x == 0xbf30 || x == 0xf3af8003) {
        sys.waiting = !irq;
        return;
      }
      if ((x & 0xfff0ff00) == 0xf3d08f00) {
        sys.exception_return(*jit, r[(x >> 16) & 15] - (x & 255),
                             sys.banks.spsr[ArmSystem::bank(cpsr)]);
        return;
      }
      if ((x & 0xffe0f0ff) == 0xf3808000) {
        status_write(x & (1 << 20), (x >> 8) & 15, r[(x >> 16) & 15]);
        return;
      }
      if ((x & 0xffeff0ff) == 0xf3ef8000) {
        r[(x >> 8) & 15] = (x & (1 << 20))
                               ? sys.banks.spsr[ArmSystem::bank(cpsr)]
                               : (cpsr & ~0x0720fc20u);
        return;
      }
      if (size == 4 && coprocessor(x))
        return;
      undefined(pc, size);
      return;
    }
    if (coprocessor(x))
      return;
    if ((x & 0x0ffffff0) == 0x0320f000) {
      if ((x & 15) == 3)
        sys.waiting = !irq;
      if ((x & 15) <= 5)
        return;
    }
    if ((x & 0xfff10020) == 0xf1000000) {
      if ((cpsr & 31) != 16) {
        U32 v = cpsr, mask = (x & 0x1c0);
        if ((x >> 18) & 2)
          v = (x & (1 << 18)) ? v | mask : v & ~mask;
        if (x & (1 << 17))
          v = (v & ~31u) | (x & 31);
        sys.set_cpsr(*jit, v);
      }
      return;
    }
    if ((x & 0x0fff0fff) == 0x014f0000) {
      r[(x >> 12) & 15] = sys.banks.spsr[ArmSystem::bank(cpsr)];
      return;
    }
    if ((x & 0x0fb0fff0) == 0x0120f000 || (x & 0x0fb0f000) == 0x0320f000) {
      status_write(x & (1 << 22), (x >> 16) & 15, operand2(x, pc));
      return;
    }
    if ((x & 0x0fb00eff) == 0x01000200 || (x & 0x0fb0fef0) == 0x0120f200) {
      if (bank_transfer(x))
        return;
      undefined(pc, size);
      return;
    }
    if ((x & 0x0c10f000) == 0x0010f000) {
      U32 a = r[(x >> 16) & 15], b = operand2(x, pc), v = 0,
          c = (cpsr >> 29) & 1;
      switch ((x >> 21) & 15) {
      case 0:
        v = a & b;
        break;
      case 1:
        v = a ^ b;
        break;
      case 2:
        v = a - b;
        break;
      case 3:
        v = b - a;
        break;
      case 4:
        v = a + b;
        break;
      case 5:
        v = a + b + c;
        break;
      case 6:
        v = a - b + c - 1;
        break;
      case 7:
        v = b - a + c - 1;
        break;
      case 12:
        v = a | b;
        break;
      case 13:
        v = b;
        break;
      case 14:
        v = a & ~b;
        break;
      case 15:
        v = ~b;
        break;
      default:
        undefined(pc, size);
        return;
      }
      sys.exception_return(*jit, v, sys.banks.spsr[ArmSystem::bank(cpsr)]);
      return;
    }
    if ((x & 0xfe50ffff) ==
        0xf8100a00) { // RFE (two words, all addressing modes)
      unsigned rn = (x >> 16) & 15;
      U32 base = r[rn];
      U32 start = (x & (1 << 23)) ? base : base - 8;
      if (bool(x & (1 << 24)) == bool(x & (1 << 23)))
        start += 4;
      U32 dest = read(start, 4), saved = read(start + 4, 4);
      if (x & (1 << 21))
        r[rn] = (x & (1 << 23)) ? base + 8 : base - 8;
      sys.exception_return(*jit, dest, saved);
      return;
    }
    if ((x & 0xfe5fffe0) == 0xf84d0500) { // SRS
      auto &sp = sys.banked(*jit, x & 31, 13);
      U32 base = sp;
      U32 start = (x & (1 << 23)) ? base : base - 8;
      if (bool(x & (1 << 24)) == bool(x & (1 << 23)))
        start += 4;
      write(start, 4, r[14]);
      write(start + 4, 4, sys.banks.spsr[ArmSystem::bank(cpsr)]);
      if (x & (1 << 21))
        sp = (x & (1 << 23)) ? base + 8 : base - 8;
      return;
    }
    if ((x & 0x0e400000) ==
        0x08400000) { // LDM/STM user bank, or LDM exception return
      bool load = x & (1 << 20), restore = load && (x & 0x8000);
      unsigned rn = (x >> 16) & 15, count = std::popcount(x & 0xffff);
      U32 base = r[rn];
      if (!count) {
        undefined(pc, size);
        return;
      }
      U32 addr = (x & (1 << 23)) ? base : base - 4 * count;
      if (bool(x & (1 << 24)) == bool(x & (1 << 23)))
        addr += 4;
      U32 dest = 0;
      for (unsigned reg = 0; reg < 16; reg++)
        if (x & (1 << reg)) {
          U32 &target = restore || reg < 8 || reg == 15
                            ? r[reg]
                            : sys.banked(*jit, 16, reg);
          if (load) {
            U32 v = read(addr, 4);
            if (reg == 15)
              dest = v;
            else
              target = v;
          } else
            write(addr, 4, reg == 15 ? pc + 12 : target);
          addr += 4;
        }
      if (x & (1 << 21))
        r[rn] = (x & (1 << 23)) ? base + 4 * count : base - 4 * count;
      if (restore)
        sys.exception_return(*jit, dest, sys.banks.spsr[ArmSystem::bank(cpsr)]);
      return;
    }
    if ((x & 0x0fffffff) == 0x0320f003) {
      sys.waiting = !irq;
      return;
    }
    undefined(pc, size);
  }
  static bool system(U32 x) {
    return (x & 0x0f000f10) == 0x0e000f10 || (x & 0x0fe00f00) == 0x0c400f00 ||
           (x & 0xfff10020) == 0xf1000000 || (x & 0x0fff0fff) == 0x014f0000 ||
           (x & 0x0fb0fff0) == 0x0120f000 || (x & 0x0fb0f000) == 0x0320f000 ||
           (x & 0x0fb00eff) == 0x01000200 || (x & 0x0fb0fef0) == 0x0120f200 ||
           (x & 0x0c10f000) == 0x0010f000 || (x & 0x0e400000) == 0x08400000 ||
           (x & 0x0fff0fff) == 0x0ef80a10 || (x & 0x0fff0fff) == 0x0ee80a10;
  }
  bool PreCodeReadHook(bool thumb, U32 pc, A32::IREmitter &ir) override {
    U32 start = A32::LocationDescriptor{ir.block.Location()}.PC();
    if (pc != start && (exact || pc == until || interested(1, pc) ||
                        interested(2, pc) || ir.block.CycleCount() >= 64)) {
      ir.SetTerm(IR::Term::LinkBlock{ir.current_location});
      return false;
    }
    U32 x = read(pc, thumb ? 2 : 4, true);
    bool privileged = thumb ? (x & 0xffe8) == 0xb660 || x == 0xbf30 : system(x);
    if (thumb && (x & 0xf800) >= 0xe800) {
      x = (x << 16) | U32(read(pc + 2, 2, true));
      privileged =
          x == 0xf3af8003 || (x & 0xffe0f0ff) == 0xf3808000 ||
          (x & 0xffeff0ff) == 0xf3ef8000 || (x & 0xfff0ff00) == 0xf3d08f00 ||
          (x & 0x0f000f10) == 0x0e000f10 || (x & 0x0fe00f00) == 0x0c400f00;
    }
    if (privileged) {
      if (pc != start) {
        ir.SetTerm(IR::Term::LinkBlock{ir.current_location});
        return false;
      }
      ir.block.CycleCount() = 0;
      ir.SetTerm(IR::Term::Interpret{ir.current_location});
      return false;
    }
    return true;
  }
  void InterpreterFallback(U32 a, size_t n) override {
    if (n != 1) {
      fault(a, 100);
      return;
    }
    pending = true;
    pending_pc = a;
    jit->Regs()[15] = a;
    jit->HaltExecution();
  }
  void CallSVC(U32) override {
    const U32 pc = jit->Regs()[15];
    if (interested(6, pc))
      emit(6, pc, 0, 2);
    else {
      sys.exception(*jit, 19, 8, pc, false);
      redispatch = true;
      jit->HaltExecution();
    }
  }
  void ExceptionRaised(U32 pc, A32::Exception e) override {
    if (e == A32::Exception::Yield || e == A32::Exception::WaitForEvent ||
        e == A32::Exception::SendEvent || e == A32::Exception::SendEventLocal ||
        e == A32::Exception::PreloadData ||
        e == A32::Exception::PreloadDataWithIntentToWrite ||
        e == A32::Exception::PreloadInstruction)
      return;
    pending = true;
    pending_pc = pc;
    jit->HaltExecution();
  }
  void update_clock(U64 ns) {
    if (!clock)
      return;
    U64 delta = ns - now;
    now = ns;
    U64 fraction = remainder + delta * freq;
    ticks += fraction / 1000000000;
    remainder = fraction % 1000000000;
    auto l = sys.advance(ticks);
    if (now >= deadline || l != levels) {
      levels = l;
      clock(now, l);
    }
  }
  void AddTicks(U64 n) override {
    charged += n;
    jit_count += n;
    update_clock(now + n * unit);
  }
  U64 GetTicksRemaining() override {
    // A transient request only forces the current in-region edge to return.
    // Exact execution and `until` remain disabled for subsequent compilation.
    boundary.flags =
        (exact || until) ? Backend::Wasm::kBoundaryDisableRegions : 0;
    if (stopped || pending || charged >= budget || (sys.waiting && !irq) ||
        (until && jit->Regs()[15] == until)) {
      jit->HaltExecution();
      return 0;
    }
    if (irq && !(jit->Cpsr() & 128)) {
      sys.exception(*jit, 18, 0x18, jit->Regs()[15] + 4, true);
      irq_count++;
    }
    do {
      native_redirect = false;
      U32 pc = jit->Regs()[15];
      if (interested(2, pc))
        emit(2, pc, 4);
      if (interested(1, pc))
        emit(1, pc, 4);
    } while (native_redirect && !stopped);
    if (stopped)
      jit->HaltExecution();

    // AddTicks advances both virtual time and the timer counter. Bound this
    // native dispatch's allowance to the first event it must observe.
    U64 allowance = budget - charged;
    if (clock && deadline > now && unit)
      allowance = std::min(allowance, (deadline - now + unit - 1) / unit);
    if (sys.next_timer != Never && sys.next_timer > ticks && unit && freq) {
      const U64 rate = U64(unit) * freq;
      const U64 needed = (sys.next_timer - ticks) * 1000000000 - remainder;
      allowance = std::min(allowance, (needed + rate - 1) / rate);
    }
    return std::max<U64>(1, allowance);
  }
  void after_ticks() {
    // The dispatcher charged the completed region before this observer.
    // Interpret exits materialize state and leave the system instruction for
    // native execution. Clear only our fallback halt, preserving invalidation
    // and any explicit stop requested by callbacks.
    if (pending && !stopped) {
      pending = false;
      jit->ClearHalt();
      jit->Regs()[15] = pending_pc;
      execute_system(pending_pc);
      charged++;
      slow_count++;
      update_clock(now + unit);
      if (error || stopped || (sys.waiting && !irq))
        jit->HaltExecution();
    } else if (redispatch && !stopped) {
      redispatch = false;
      jit->ClearHalt();
    }
  }
  U32 run(U32 begin, U32 count, U32 end, bool single) {
    if (exact != single || until != end)
      jit->ClearCache();
    exact = single;
    until = end;
    budget = count;
    charged = 0;
    error = 0;
    stopped = false;
    pending = false;
    redispatch = false;
    jit->SetCpsr((jit->Cpsr() & ~32u) | (begin & 1 ? 32 : 0));
    jit->Regs()[15] = begin & ~1u;
    // Explicit execution resumes WFI; the board normally idles until an IRQ.
    sys.waiting = false;
    while (!stopped && charged < budget) {
      jit->ClearHalt();
      jit->Run();
      if (!pending) {
        if (redispatch) {
          redispatch = false;
          continue;
        }
        break;
      }
      pending = false;
      jit->Regs()[15] = pending_pc;
      execute_system(pending_pc);
      charged++;
      slow_count++;
      update_clock(now + unit);
      if (error || (sys.waiting && !irq))
        break;
    }
    return charged;
  }
};
extern "C" {
EMSCRIPTEN_KEEPALIVE Host *dh_create(Callback cb) { return new Host(cb); }
EMSCRIPTEN_KEEPALIVE void dh_destroy(Host *h) { delete h; }
EMSCRIPTEN_KEEPALIVE U32 dh_map(Host *h, U32 a, U32 n, U32 p) {
  return h->map(a, n, p);
}
EMSCRIPTEN_KEEPALIVE U32 dh_unmap(Host *h, U32 a, U32 n) {
  return h->unmap(a, n);
}
EMSCRIPTEN_KEEPALIVE U32 dh_protect(Host *h, U32 a, U32 n, U32 p) {
  return h->protect(a, n, p);
}
EMSCRIPTEN_KEEPALIVE U32 dh_read(Host *h, U32 a, U32 n, uint8_t *p) {
  return h->transfer(a, n, p, false);
}
EMSCRIPTEN_KEEPALIVE U32 dh_view(Host *h, U32 a, U32 n, uint8_t **p) {
  return h->view(a, n, p);
}
EMSCRIPTEN_KEEPALIVE U32 dh_write(Host *h, U32 a, U32 n, uint8_t *p) {
  return h->transfer(a, n, p, true);
}
EMSCRIPTEN_KEEPALIVE U32 dh_copy(Host *h, U32 d, U32 s, U32 n) {
  return h->copy(d, s, n);
}
EMSCRIPTEN_KEEPALIVE U32 dh_fill(Host *h, U32 a, U32 n, U32 v) {
  return h->fill(a, n, v);
}
EMSCRIPTEN_KEEPALIVE U32 dh_compose4(Host *h, const NativeComposeSurface *s,
                                     const NativeComposeLayer *layers,
                                     U32 count) {
  return h->compose4(s, layers, count);
}
EMSCRIPTEN_KEEPALIVE U32 dh_run(Host *h, U32 b, U32 n, U32 e, U32 exact) {
  return h->run(b, n, e, exact);
}
EMSCRIPTEN_KEEPALIVE U32 dh_error(Host *h) { return h->error; }
EMSCRIPTEN_KEEPALIVE U32 dh_reg_read(Host *h, U32 i) {
  if (i < 16)
    return h->jit->Regs()[i];
  if (i == 16)
    return h->jit->Cpsr();
  if (i == 17)
    return h->sys.banks.spsr[ArmSystem::bank(h->jit->Cpsr())];
  if (i == 18)
    return h->sys.banks.fpexc;
  return h->jit->Fpscr();
}
EMSCRIPTEN_KEEPALIVE void dh_reg_write(Host *h, U32 i, U32 v) {
  if (i < 16)
    h->jit->Regs()[i] = v;
  else if (i == 16)
    h->sys.set_cpsr(*h->jit, v);
  else if (i == 17)
    h->sys.banks.spsr[ArmSystem::bank(h->jit->Cpsr())] = v;
  else if (i == 18)
    h->sys.banks.fpexc = v;
  else
    h->jit->SetFpscr(v);
}
EMSCRIPTEN_KEEPALIVE U32 *dh_fp(Host *h, U32 index, U32 size) {
  if (size != 4 && size != 8 && size != 16)
    return nullptr;
  if (index >= (size == 4 ? 32 : 256 / size))
    return nullptr;
  return &h->jit->ExtRegs()[index * (size / 4)];
}
struct Snapshot {
  std::array<U32, 16> regs;
  std::array<U32, 64> ext;
  U32 cpsr, fpscr;
  ArmSystem::Banks banks;
  ArmControl control;
};
EMSCRIPTEN_KEEPALIVE Snapshot *dh_save(Host *h) {
  return new Snapshot{h->jit->Regs(),  h->jit->ExtRegs(), h->jit->Cpsr(),
                      h->jit->Fpscr(), h->sys.banks,      h->sys};
}
EMSCRIPTEN_KEEPALIVE void dh_restore(Host *h, Snapshot *s) {
  h->jit->Regs() = s->regs;
  h->jit->ExtRegs() = s->ext;
  h->jit->SetCpsr(s->cpsr);
  h->jit->SetFpscr(s->fpscr);
  h->sys.banks = s->banks;
  static_cast<ArmControl &>(h->sys) = s->control;
  h->sys.dirty = true;
  h->jit->ClearExclusiveState();
}
EMSCRIPTEN_KEEPALIVE void dh_free_context(Snapshot *s) { delete s; }
EMSCRIPTEN_KEEPALIVE void dh_configure(Host *h, U32 f, U32 m) {
  h->sys.configure(f, m);
}
EMSCRIPTEN_KEEPALIVE U32 dh_advance(Host *h, U64 t) {
  h->request_boundary();
  return h->sys.advance(t);
}
EMSCRIPTEN_KEEPALIVE U32 dh_waiting(Host *h) {
  return h->sys.waiting && !h->irq;
}
EMSCRIPTEN_KEEPALIVE const U64 *dh_hook_profile(Host *h) {
#ifdef XHALF_PROFILE_HOOKS
  return h->hook_profile.data();
#else
  return nullptr;
#endif
}
EMSCRIPTEN_KEEPALIVE U32 dh_hook(Host *h, U32 k, U32 b, U32 e) {
  U32 id = h->next++;
  h->hooks.push_back({id, k, b, e});
  h->index_hooks();
  if (k == 3 || k == 4)
    h->refresh();
  h->jit->ClearCache();
  return id;
}
// Opt-in AAPCS unsigned division replacement. The SDK caller validates the
// firmware binding before installation; this runtime owns no guest addresses.
EMSCRIPTEN_KEEPALIVE U32 dh_division_hook(Host *h, U32 pc, U32 remainder) {
  U32 id = h->next++;
  h->hooks.push_back({id, 1, pc, pc, remainder ? 2u : 1u});
  h->index_hooks();
  h->jit->ClearCache();
  return id;
}
EMSCRIPTEN_KEEPALIVE U64 dh_division_count(Host *h) {
  return h->division_count;
}
EMSCRIPTEN_KEEPALIVE void dh_unhook(Host *h, U32 id) {
  std::erase_if(h->hooks, [&](auto &x) { return x.id == id; });
  h->index_hooks();
  h->refresh();
  h->jit->ClearCache();
}
EMSCRIPTEN_KEEPALIVE void dh_stop(Host *h) {
  h->stopped = true;
  h->request_boundary();
  h->jit->HaltExecution();
}
EMSCRIPTEN_KEEPALIVE void dh_invalidate(Host *h, U32 a, U32 n) {
  h->request_boundary();
  if (n)
    h->jit->InvalidateCacheRange(a, n);
  else
    h->jit->ClearCache();
}
EMSCRIPTEN_KEEPALIVE void dh_irq(Host *h, U32 on) {
  h->irq = on;
  h->request_boundary();
  if (on)
    h->sys.waiting = false;
}
EMSCRIPTEN_KEEPALIVE void dh_clock(Host *h, U32 unit, U32 f, Clock cb) {
  h->unit = unit;
  h->freq = f;
  h->clock = cb;
  h->request_boundary();
}
EMSCRIPTEN_KEEPALIVE U64 dh_now(Host *h) { return h->now; }
EMSCRIPTEN_KEEPALIVE void dh_deadline(Host *h, U64 d) {
  h->deadline = d;
  h->request_boundary();
}
EMSCRIPTEN_KEEPALIVE void dh_idle(Host *h, U64 limit) {
  h->sys.advance(h->sys.counter);
  auto t = h->sys.next_timer;
  if (t != Never) {
    U64 expiry = t / h->freq * 1000000000 +
                 (t % h->freq * 1000000000 + h->freq - 1) / h->freq;
    limit = std::min(limit, expiry);
  }
  limit = std::min(limit, h->deadline);
  if (limit > h->now)
    h->update_clock(limit);
}
EMSCRIPTEN_KEEPALIVE U64 dh_jit_count(Host *h) { return h->jit_count; }
EMSCRIPTEN_KEEPALIVE U64 dh_slow_count(Host *h) { return h->slow_count; }
EMSCRIPTEN_KEEPALIVE U64 dh_irq_count(Host *h) { return h->irq_count; }
EMSCRIPTEN_KEEPALIVE U64 dh_undefined_count(Host *h) {
  return h->undefined_count;
}
EMSCRIPTEN_KEEPALIVE U32 dh_undefined_pc(Host *h) { return h->undefined_pc; }
}
