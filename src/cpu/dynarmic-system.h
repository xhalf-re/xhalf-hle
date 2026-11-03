// ARMv7-A privileged state for the Dynarmic CPU. No guest addresses or SDK
// policy.
#pragma once
#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>

struct ArmControl {
  using U32 = uint32_t;
  U32 sctlr = 0x00c50078, vbar = 0, cpacr = 0, scr = 0;
  U32 frequency = 27000000, cntkctl = 0, cnthctl = 0;
  U32 tpidrurw = 0, tpidruro = 0, tpidrprw = 0, contextidr = 0;
  U32 ttbr0 = 0, ttbr1 = 0, ttbcr = 0, dacr = 0, dfsr = 0, ifsr = 0;
  U32 dfar = 0, ifar = 0, csselr = 0, actlr = 0;
};

struct ArmSystem : ArmControl {
  using U32 = uint32_t;
  using U64 = uint64_t;
  // User/System share a bank; FIQ owns r8-r14; other modes own SP/LR/SPSR.
  struct Banks {
    std::array<U32, 5> user_high{}, fiq_high{};
    std::array<U32, 32> sp{}, lr{}, spsr{};
    U32 fpexc = 0;
  } banks;
  struct Timer {
    U64 compare = 0;
    U32 control = 0;
  };
  std::array<Timer, 5> timers{};
  U32 mpidr = 0;
  U64 counter = 0, offset = 0, next_timer = ~U64(0);
  U32 timer_levels = 0;
  bool dirty = true, waiting = false;

  static unsigned bank(U32 cpsr) {
    const unsigned m = cpsr & 31;
    return m == 31 ? 16 : m;
  }
  static bool mode(U32 m) {
    return m == 16 || m == 17 || m == 18 || m == 19 || m == 22 || m == 23 ||
           m == 27 || m == 31;
  }
  template <class Jit> void set_cpsr(Jit &jit, U32 value) {
    const U32 old = jit.Cpsr();
    if (!mode(value & 31))
      value = (value & ~31u) | (old & 31);
    const unsigned a = bank(old), b = bank(value);
    auto &r = jit.Regs();
    if (a != b) {
      banks.sp[a] = r[13];
      banks.lr[a] = r[14];
      if ((a == 17) != (b == 17)) {
        auto &save = a == 17 ? banks.fiq_high : banks.user_high;
        auto &load = b == 17 ? banks.fiq_high : banks.user_high;
        for (unsigned i = 0; i < 5; i++) {
          save[i] = r[8 + i];
          r[8 + i] = load[i];
        }
      }
      r[13] = banks.sp[b];
      r[14] = banks.lr[b];
    }
    jit.SetCpsr(value);
  }
  template <class Jit> U32 &banked(Jit &jit, unsigned m, unsigned reg) {
    auto current = bank(jit.Cpsr());
    m = bank(m);
    if (reg < 13) {
      if ((m == 17) == (current == 17))
        return jit.Regs()[reg];
      return m == 17 ? banks.fiq_high[reg - 8] : banks.user_high[reg - 8];
    }
    if (m == current)
      return jit.Regs()[reg];
    return reg == 13 ? banks.sp[m] : banks.lr[m];
  }
  template <class Jit>
  void exception(Jit &jit, unsigned m, U32 vector, U32 lr, bool abort_mask) {
    const U32 old = jit.Cpsr();
    // Exception entry clears IT/J/T, sets I, takes E/TE from SCTLR.
    U32 next = (old & ~0x0700fe3fu) | m | 0x80;
    next = (next & ~0x200u) | ((sctlr >> 16) & 0x200);
    if (abort_mask)
      next |= 0x100;
    if (sctlr & (1u << 30))
      next |= 0x20;
    set_cpsr(jit, next);
    banks.spsr[bank(next)] = old;
    jit.Regs()[14] = lr;
    jit.Regs()[15] = (sctlr & 0x2000 ? 0xffff0000u : vbar) + vector;
    jit.ClearExclusiveState();
    waiting = false;
  }
  template <class Jit> void exception_return(Jit &jit, U32 pc, U32 saved) {
    set_cpsr(jit, saved);
    jit.Regs()[15] = pc & (saved & 32 ? ~1u : ~3u);
  }
  U32 advance(U64 value) {
    if (!dirty && value >= counter && value < next_timer) {
      counter = value;
      return timer_levels;
    }
    counter = value;
    next_timer = ~U64(0);
    timer_levels = 0;
    dirty = false;
    for (unsigned i = 0; i < timers.size(); i++) {
      auto &t = timers[i];
      U64 off = (i == 1 || i == 4) ? offset : 0;
      bool expired = (t.control & 1) && counter - off >= t.compare;
      t.control = (t.control & 3) | (expired ? 4 : 0);
      if ((t.control & 7) == 5)
        timer_levels |= 1u << i;
      if (t.control & 1) {
        if (off > counter)
          next_timer = std::min(next_timer, off);
        U64 expiry = t.compare + off;
        if (expiry > counter)
          next_timer = std::min(next_timer, expiry);
      }
    }
    return timer_levels;
  }
  void configure(U32 f, U32 m) {
    frequency = f;
    mpidr = m;
    counter = 0;
    timers = {};
    dirty = true;
  }
  // Returns false for an unsupported encoding: callers raise an architectural
  // undefined-instruction exception instead of silently accepting it.
  bool cp15(bool load, unsigned opc1, unsigned crn, unsigned crm, unsigned opc2,
            U32 &value) {
    U32 *reg = nullptr;
    // Match the reference Cortex-A15 C15_IMPDEF bank: RAZ/WI.
    if (crn == 15) {
      if (load)
        value = 0;
      return true;
    }
    if (crn == 0 && load) {
      if (opc1 == 0 && crm == 0) {
        switch (opc2) {
        case 0:
          value = 0x412fc0f1;
          return true; // Cortex-A15 MIDR
        case 1:
          value = 0x8444c004;
          return true; // CTR
        case 5:
          value = mpidr;
          return true;
        }
      }
      if (opc1 == 1 && crm == 0 && opc2 == 0) {
        value = 0x701fe00a;
        return true;
      }
      if (opc1 == 1 && crm == 0 && opc2 == 1) {
        value = 0x0a200023;
        return true;
      }
    }
    if (crn == 0 && opc1 == 2 && crm == 0 && opc2 == 0)
      reg = &csselr;
    if (crn == 1 && opc1 == 0 && crm == 0) {
      if (opc2 == 0)
        reg = &sctlr;
      if (opc2 == 1)
        reg = &actlr;
      if (opc2 == 2)
        reg = &cpacr;
    }
    if (crn == 1 && opc1 == 0 && crm == 1 && opc2 == 0)
      reg = &scr;
    if (crn == 2 && opc1 == 0 && crm == 0) {
      if (opc2 == 0)
        reg = &ttbr0;
      if (opc2 == 1)
        reg = &ttbr1;
      if (opc2 == 2)
        reg = &ttbcr;
    }
    if (crn == 3 && opc1 == 0 && crm == 0 && opc2 == 0)
      reg = &dacr;
    if (crn == 5 && opc1 == 0 && crm == 0) {
      if (opc2 == 0)
        reg = &dfsr;
      if (opc2 == 1)
        reg = &ifsr;
    }
    if (crn == 6 && opc1 == 0 && crm == 0) {
      if (opc2 == 0)
        reg = &dfar;
      if (opc2 == 2)
        reg = &ifar;
    }
    if (crn == 12 && opc1 == 0 && crm == 0 && opc2 == 0)
      reg = &vbar;
    if (crn == 13 && opc1 == 0 && crm == 0) {
      if (opc2 == 1)
        reg = &contextidr;
      if (opc2 == 2)
        reg = &tpidrurw;
      if (opc2 == 3)
        reg = &tpidruro;
      if (opc2 == 4)
        reg = &tpidrprw;
    }
    if (crn == 14) {
      if (opc1 == 0 && crm == 0 && opc2 == 0)
        reg = &frequency;
      if (opc1 == 0 && crm == 1 && opc2 == 0)
        reg = &cntkctl;
      if (opc1 == 4 && crm == 1 && opc2 == 0)
        reg = &cnthctl;
      int index = opc1 == 0               ? (crm == 2   ? 0
                                             : crm == 3 ? 1
                                                        : -1)
                  : opc1 == 4             ? (crm == 2   ? 2
                                             : crm == 3 ? 4
                                                        : -1)
                  : opc1 == 1 && crm == 2 ? 3
                                          : -1;
      if (index >= 0 && opc2 <= 1) {
        auto &t = timers[index];
        U64 count = counter - ((index == 1 || index == 4) ? offset : 0);
        advance(counter);
        if (load)
          value = opc2 ? t.control : U32(t.compare - count);
        else {
          if (opc2)
            t.control = value & 3;
          else
            t.compare = count + int64_t(int32_t(value));
          dirty = true;
        }
        return true;
      }
    }
    if (reg) {
      if (load)
        value = *reg;
      else
        *reg = reg == &vbar ? value & ~31u : value;
      return true;
    }
    // Cache/TLB maintenance is coherent in this physical-memory CPU.
    // Instruction cache invalidation is performed by the host after the
    // operation returns.
    if (!load && opc1 == 0 && (crn == 7 || crn == 8))
      return true;
    return false;
  }
  bool cp15_pair(bool load, unsigned opc, unsigned crm, U64 &value) {
    if (crm != 14)
      return false;
    if (load && opc <= 1) {
      value = counter - (opc == 1 ? offset : 0);
      return true;
    }
    if (opc == 4) {
      if (load)
        value = offset;
      else {
        offset = value;
        dirty = true;
      }
      return true;
    }
    int index = opc == 2    ? 0
                : opc == 3  ? 1
                : opc == 6  ? 2
                : opc == 7  ? 4
                : opc == 10 ? 3
                            : -1;
    if (index < 0)
      return false;
    if (load)
      value = timers[index].compare;
    else {
      timers[index].compare = value;
      dirty = true;
    }
    return true;
  }
};
