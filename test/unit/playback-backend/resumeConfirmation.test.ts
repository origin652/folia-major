import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createResumeConfirmation } from '../../../src/services/playbackBackend/resumeConfirmation';

// A desired timestamp, even acknowledged by the player, is not proof of resumed audio input.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const sample = (position = 42) => ({ sourceId: 'new', state: 'playing' as const, position, duration: 180 });

it('does not confirm a single target timestamp or repeated stationary native feedback', async () => {
    const confirmation = createResumeConfirmation(1500);
    confirmation.begin('new', 42);
    confirmation.observe(sample());
    let resolved = false;
    const waiting = confirmation.wait(() => true).then(() => { resolved = true; });
    const result = expect(waiting).rejects.toThrow('confirm');
    await vi.advanceTimersByTimeAsync(500);
    confirmation.observe(sample());
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
});

it('requires both an advancing observed clock and current input evidence', async () => {
    const confirmation = createResumeConfirmation();
    let inputReady = false, result: unknown;
    confirmation.begin('new', 42);
    confirmation.observe(sample());
    const waiting = confirmation.wait(() => true, async () => inputReady).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(500);
    confirmation.observe(sample(42.5));
    await vi.advanceTimersByTimeAsync(500);
    expect(result).toBeUndefined();
    inputReady = true;
    await vi.advanceTimersByTimeAsync(250);
    await waiting;
    expect(result).toMatchObject({ sourceId: 'new', position: 42.5 });
});

it('does not reuse an old advancing sample after the player clock has stalled', async () => {
    const confirmation = createResumeConfirmation(4000);
    let inputReady = false, resolved = false;
    confirmation.begin('new', 42);
    confirmation.observe(sample());
    const waiting = confirmation.wait(() => true, async () => inputReady).then(() => { resolved = true; });
    const result = expect(waiting).rejects.toThrow('confirm');
    await vi.advanceTimersByTimeAsync(500);
    confirmation.observe(sample(42.5));
    await vi.advanceTimersByTimeAsync(2000);
    inputReady = true;
    confirmation.observe(sample(42.5));
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
});

it('a source replacement or pause cancels confirmation and cannot complete later', async () => {
    const confirmation = createResumeConfirmation();
    confirmation.begin('new', 42);
    const waiting = confirmation.wait(() => true);
    confirmation.observe(sample());
    await vi.advanceTimersByTimeAsync(500);
    confirmation.observe({ ...sample(42.5), sourceId: 'retired' });
    confirmation.cancel();
    await expect(waiting).resolves.toBeNull();
});
