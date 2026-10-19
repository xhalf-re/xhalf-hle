export type FirmwareErrorCode =
  | 'INVALID_PACKAGE'
  | 'MISSING_RESOURCE'
  | 'UNKNOWN_FIRMWARE'
  | 'PROFILE_MISMATCH'
  | 'INVALID_FILESYSTEM'
  | 'CANCELLED';
export class FirmwareError extends Error {
  constructor(
    public readonly code: FirmwareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FirmwareError';
  }
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new FirmwareError('CANCELLED', 'Loading cancelled.');
}
