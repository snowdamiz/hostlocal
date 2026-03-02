import { describe, expect, it } from "vitest";
import { createIntakeToastStore } from "./toast-store";

describe("createIntakeToastStore", () => {
  it("collapses repeated identical rejections into one toast with an incremented count", () => {
    let nowMs = 10_000;
    const store = createIntakeToastStore({
      dedupeWindowMs: 8_000,
      autoDismissMs: 12_000,
      now: () => nowMs,
    });

    store.pushRejectionToast("empty_body");
    nowMs += 500;
    store.pushRejectionToast("empty_body");

    const toasts = store.getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].count).toBe(2);
    expect(toasts[0].reasonCode).toBe("empty_body");
  });

  it("creates a new toast entry when the dedupe window expires or reason signature changes", () => {
    let nowMs = 10_000;
    const store = createIntakeToastStore({
      dedupeWindowMs: 8_000,
      autoDismissMs: 12_000,
      now: () => nowMs,
    });

    const first = store.pushRejectionToast("empty_body");
    nowMs += 8_500;
    const second = store.pushRejectionToast("empty_body");
    const third = store.pushRejectionToast("missing_intake_label");

    const toasts = store.getToasts();
    expect(toasts).toHaveLength(3);
    expect(second.id).not.toBe(first.id);
    expect(third.signature).not.toBe(second.signature);
  });

  it("supports dismiss and clear operations for viewport lifecycle control", () => {
    const store = createIntakeToastStore();
    const first = store.pushRejectionToast("empty_body");
    store.pushRejectionToast("missing_intake_label");

    store.dismissToast(first.id);
    expect(store.getToasts()).toHaveLength(1);
    expect(store.getToasts()[0].reasonCode).toBe("missing_intake_label");

    store.clearToasts();
    expect(store.getToasts()).toHaveLength(0);
  });
});
