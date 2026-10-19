# Adapting a firmware version

Analyze each new version in private storage. Keep original DAT files, desktop ELF files, extracted resources and traces outside public source and build artifacts. Record machine, SDK, payload, container and A/B resource identities, with evidence for addresses, layouts, startup assumptions, required hooks, optional accelerations and input ABIs.

Use `scripts/migrate-profile.py` to generate a Web schema 2 candidate. Public output may contain lengths, SHA-256 digests and interoperability metadata, but no original instruction fragments, locator patterns, resources or snapshots. Keep `status: candidate` until review and real-firmware verification are complete. Preflight rejects candidates, moved addresses without valid guards, incompatible layouts, missing required bindings and identity mismatches.

Review in this order:

1. Run synthetic SUNP/HDR2, FAT, layout-boundary, required-rejection and optional-fallback tests.
2. Document each new hook's semantics, AAPCS arguments, legal context and return contract. Put version-specific behavior in profiles or SDK adapters; keep firmware-address branches out of generic services.
3. Use a private DAT for preflight, cold boot, display, native input, menus, power and unavailable-hardware paths. ASSERTs, unexpected PCs, permanent waits or input backlog fail verification.
4. Compare desktop and browser stable frames at the same state and virtual time. Do not import a desktop CPU snapshot to advance browser execution.
5. Run `npm run check`, the license/public-content audit and a production build. Only then promote the profile to `supported`, recording its identity and verification results with the change.

Unknown versions fail with `UNKNOWN_FIRMWARE` or `PROFILE_MISMATCH`. Successful synthetic migration tests do not imply support for an untested firmware version.

Input adaptation belongs at SDK/device boundaries. Do not add menu handler tables, row geometry or selection helpers to extend keyboard support. Verify touch-only menus through direct screen input. Controller axis transforms, held sampling, activity wakeup, cancellation resets and native thread context require private regression coverage.

Storage adaptation must resolve and guard the native block registry APIs, disk context layout, boot initializer and media mount callback. The virtual ARM driver registers A/B devices through those APIs; retain original VFS/FAT execution. Run the private all-file and B write/seek/reset test before accepting the adaptation. Keep physical NAND/ECC/FTL behavior outside the logical disk mock's claims.

System timers and MPIDR must be adapted through the machine/CPU system-register model, not through firmware PC sites or MOV patches. Validate the counter frequency, CPU identity and timer IRQ wiring. Display adaptation must retain the native scan/blank interrupt path; Canvas acknowledgements and native display completion remain independent. Run `tests/private/hardware-completion.test.ts` to verify unchanged MPIDR instructions, absence of retired timer hooks and actual device IRQ completion.
