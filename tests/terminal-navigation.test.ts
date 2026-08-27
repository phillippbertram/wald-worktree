import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  search: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  checkbox: prompts.checkbox,
  confirm: prompts.confirm,
  input: prompts.input,
  search: prompts.search,
  select: prompts.select,
  Separator: class Separator {
    constructor(readonly separator?: string) {}
  },
}));

import {
  confirm,
  PromptBackError,
  PromptExitError,
  promptText,
  selectManyValues,
  selectValue,
} from "../src/ui/terminal.js";

describe("terminal prompt navigation", () => {
  beforeEach(() => {
    for (const prompt of Object.values(prompts)) prompt.mockReset();
  });

  it("keeps false, empty text, and an empty checkbox selection as regular answers", async () => {
    prompts.confirm.mockResolvedValue(false);
    prompts.input.mockResolvedValue("");
    prompts.checkbox.mockResolvedValue([]);

    await expect(confirm("Continue?")).resolves.toBe(false);
    await expect(promptText("Value:")).resolves.toBe("");
    await expect(selectManyValues("Values:", [])).resolves.toEqual([]);
  });

  it("translates Ctrl+C into an exit with code 130", async () => {
    const interrupted = Object.assign(new Error("interrupted"), { name: "ExitPromptError" });
    prompts.confirm.mockRejectedValue(interrupted);

    const result = confirm("Continue?").catch((error: unknown) => error);

    await expect(result).resolves.toBeInstanceOf(PromptExitError);
    await expect(result).resolves.toMatchObject({ exitCode: 130 });
  });

  it("translates Escape into a back result and removes its temporary listener", async () => {
    const listenersBefore = process.stdin.listenerCount("keypress");
    prompts.confirm.mockImplementation(
      (_config: unknown, context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortPromptError" }));
          });
          queueMicrotask(() => process.stdin.emit("keypress", "", { name: "escape" }));
        }),
    );

    await expect(confirm("Continue?", false, { navigation: "back" })).rejects.toBeInstanceOf(
      PromptBackError,
    );
    expect(process.stdin.listenerCount("keypress")).toBe(listenersBefore);
  });

  it("adds a visible Back choice and the navigation hint to single selections", async () => {
    prompts.select.mockImplementation(
      async (config: { message: string; choices: Array<{ name?: string; value?: string }> }) => {
        expect(config.message).toContain("Esc back · Ctrl+C exit");
        const back = config.choices.find((choice) => choice.name === "← Back");
        expect(back).toBeDefined();
        return back?.value;
      },
    );

    await expect(
      selectValue("Choose:", [{ label: "One", value: "one" }], { navigation: "back" }),
    ).rejects.toBeInstanceOf(PromptBackError);
  });
});
