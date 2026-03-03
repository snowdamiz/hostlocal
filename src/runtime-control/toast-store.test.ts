import { describe, expect, it } from "vitest";
import { createRuntimeControlToastStore } from "./toast-store";

describe("createRuntimeControlToastStore", () => {
  it("collapses repeated same-signature acknowledgements into one toast and increments count", () => {
    let nowMs = 10_000;
    const store = createRuntimeControlToastStore({
      dedupeWindowMs: 8_000,
      autoDismissMs: 12_000,
      now: () => nowMs,
    });

    const first = store.pushToast({
      action: "pause",
      actionLabel: "Pause run",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_paused",
      message: "Run paused.",
    });

    nowMs += 500;

    const second = store.pushToast({
      action: "pause",
      actionLabel: "Pause run",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_paused",
      message: "Run paused.",
    });

    const toasts = store.getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(2);
    expect(second.id).toBe(first.id);
  });

  it("creates a new toast when dedupe window expires or signature changes", () => {
    let nowMs = 10_000;
    const store = createRuntimeControlToastStore({
      dedupeWindowMs: 8_000,
      autoDismissMs: 12_000,
      now: () => nowMs,
    });

    const first = store.pushToast({
      action: "pause",
      actionLabel: "Pause run",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_paused",
      message: "Run paused.",
    });

    nowMs += 8_500;

    const second = store.pushToast({
      action: "pause",
      actionLabel: "Pause run",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_paused",
      message: "Run paused.",
    });

    const third = store.pushToast({
      action: "abort",
      actionLabel: "Abort run",
      status: "rejected",
      severity: "error",
      reasonCode: "runtime_abort_rejected",
      fixHint: "Run is already complete.",
      message: "Abort rejected.",
    });

    const toasts = store.getToasts();
    expect(toasts).toHaveLength(3);
    expect(second.id).not.toBe(first.id);
    expect(third.signature).not.toBe(second.signature);
  });

  it("prunes expired toasts", () => {
    let nowMs = 5_000;
    const store = createRuntimeControlToastStore({
      dedupeWindowMs: 500,
      autoDismissMs: 2_000,
      now: () => nowMs,
    });

    store.pushToast({
      action: "resume",
      actionLabel: "Resume run",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_resumed",
      message: "Run resumed.",
    });

    expect(store.getToasts()).toHaveLength(1);

    nowMs += 2_001;
    store.pruneExpired();

    expect(store.getToasts()).toHaveLength(0);
  });

  it("supports subscribe lifecycle and clone-on-read snapshots", () => {
    const store = createRuntimeControlToastStore();
    const snapshots: number[] = [];
    let leakedCount = 0;

    const unsubscribe = store.subscribe((toasts) => {
      snapshots.push(toasts.length);
      if (toasts[0]) {
        leakedCount = toasts[0].count;
        toasts[0].count = 999;
      }
    });

    store.pushToast({
      action: "steer",
      actionLabel: "Send steering",
      status: "accepted",
      severity: "success",
      reasonCode: "runtime_steer_accepted",
      message: "Instruction sent.",
    });

    expect(snapshots).toEqual([0, 1]);
    expect(leakedCount).toBe(1);
    expect(store.getToasts()[0]?.count).toBe(1);

    unsubscribe();

    store.pushToast({
      action: "steer",
      actionLabel: "Send steering",
      status: "rejected",
      severity: "error",
      reasonCode: "runtime_steer_rejected",
      fixHint: "Run is paused.",
      message: "Instruction rejected.",
    });

    expect(snapshots).toEqual([0, 1]);
  });
});
