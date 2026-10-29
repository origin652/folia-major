// Sanitized host transfer telemetry shared by the backend controller and the remote window.
export interface PlaybackTransfer {
    receivedBytes: number;
    bytesPerSecond: number;
    failure: { code: string; retryable: boolean } | null;
    failureId?: number;
    input?: {
        requestId: number;
        rangeReadId: number;
        fullReadId: number;
        seekable: boolean;
    } | null;
}
export interface AudioTransferSnapshot {
    buffering: boolean;
    bytesPerSecond: number;
}
