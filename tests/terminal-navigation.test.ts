import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => {
  const spinner = {
    clear: vi.fn(),
    start: vi.fn(),
  };
  return {
    autocomplete: vi.fn(),
    cancelValue: Symbol("clack cancel"),
    confirm: vi.fn(),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    multiselect: vi.fn(),
    select: vi.fn(),
    spinner,
    spinnerFactory: vi.fn(() => spinner),
    text: vi.fn(),
  };
});

vi.mock("@clack/prompts", () => ({
  autocomplete: prompts.autocomplete,
  confirm: prompts.confirm,
  isCancel: (value: unknown) => value === prompts.cancelValue,
  log: prompts.log,
  multiselect: prompts.multiselect,
  select: prompts.select,
  spinner: prompts.spinnerFactory,
  text: prompts.text,
}));

import {
  confirm,
  PromptBackError,
  PromptExitError,
  printStatus,
  promptText,
  runTask,
  searchSelect,
  selectManyValues,
  selectValue,
} from "../src/ui/terminal.js";

let restoreTerminalProperties: (() => void) | undefined;

describe("terminal prompt navigation", () => {
  beforeEach(() => {
    for (const prompt of [
      prompts.autocomplete,
      prompts.confirm,
      prompts.multiselect,
      prompts.select,
      prompts.spinner.clear,
      prompts.spinner.start,
      prompts.text,
      ...Object.values(prompts.log),
    ]) {
      prompt.mockReset();
    }
    prompts.spinnerFactory.mockReset();
    prompts.spinnerFactory.mockReturnValue(prompts.spinner);
  });

  afterEach(() => {
    restoreTerminalProperties?.();
    restoreTerminalProperties = undefined;
  });

  it("keeps false, empty text, and an empty multiselect as regular answers", async () => {
    prompts.confirm.mockResolvedValue(false);
    prompts.text.mockResolvedValue("");
    prompts.multiselect.mockResolvedValue([]);

    await expect(confirm("Continue?")).resolves.toBe(false);
    await expect(promptText("Value:")).resolves.toBe("");
    await expect(selectManyValues("Values:", [])).resolves.toEqual([]);
  });

  it("translates Ctrl+C into an exit with code 130 and removes its listener", async () => {
    const listenersBefore = process.stdin.listenerCount("keypress");
    prompts.confirm.mockImplementation(
      async () =>
        await resolveAfterKeypress("\u0003", {
          ctrl: true,
          name: "c",
        }),
    );

    const result = confirm("Continue?").catch((error: unknown) => error);

    await expect(result).resolves.toBeInstanceOf(PromptExitError);
    await expect(result).resolves.toMatchObject({ exitCode: 130 });
    expect(process.stdin.listenerCount("keypress")).toBe(listenersBefore);
  });

  it("translates Escape into a back result and removes its listener", async () => {
    const listenersBefore = process.stdin.listenerCount("keypress");
    prompts.confirm.mockImplementation(
      async () => await resolveAfterKeypress("", { name: "escape" }),
    );

    await expect(confirm("Continue?", false, { navigation: "back" })).rejects.toBeInstanceOf(
      PromptBackError,
    );
    expect(process.stdin.listenerCount("keypress")).toBe(listenersBefore);
  });

  it("treats an unclassified Clack cancellation as an exit", async () => {
    prompts.confirm.mockResolvedValue(prompts.cancelValue);

    await expect(confirm("Continue?")).rejects.toMatchObject({
      name: "PromptExitError",
      exitCode: 130,
    });
  });

  it("maps defaults, hints, groups, and searchable text to Clack", async () => {
    prompts.confirm.mockResolvedValue(false);
    prompts.text.mockResolvedValue("default");
    prompts.select.mockResolvedValue("one");
    prompts.autocomplete.mockResolvedValue("one");
    prompts.multiselect.mockResolvedValue(["one"]);

    await confirm("Continue?", false, { navigation: "cancel" });
    await promptText("Value:", "default", { navigation: "back" });
    await selectValue(
      "Choose:",
      [
        { label: "One", value: "one", description: "First", group: "Common" },
        { label: "Two", value: "two", group: "Common" },
        { label: "Three", value: "three", group: "Advanced" },
      ],
      { initialValue: "two", navigation: "back" },
    );
    await searchSelect(
      "Search:",
      [{ label: "\u001B[31mOne\u001B[39m", value: "one", description: "Special branch" }],
      { initialValue: "one", navigation: "cancel" },
    );
    await selectManyValues("Values:", [
      { label: "One", value: "one", checked: true },
      { label: "Two", value: "two" },
    ]);

    expect(prompts.confirm.mock.calls[0]?.[0]).toMatchObject({
      message: "Continue?",
      initialValue: false,
    });
    expect(prompts.text.mock.calls[0]?.[0]).toMatchObject({
      message: "Value:",
      initialValue: "default",
    });

    const selectOptions = prompts.select.mock.calls[0]?.[0].options;
    expect(selectOptions).toEqual([
      { value: "__ygg_group_0", label: "── COMMON ──", disabled: true },
      { value: "one", label: "One", hint: "First" },
      { value: "two", label: "Two", hint: undefined },
      { value: "__ygg_group_2", label: "── ADVANCED ──", disabled: true },
      { value: "three", label: "Three", hint: undefined },
    ]);
    expect(prompts.select.mock.calls[0]?.[0]).toMatchObject({
      initialValue: "two",
      maxItems: 10,
      message: "Choose:",
    });
    expect(selectOptions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "← Back" })]),
    );

    const autocompleteOptions = prompts.autocomplete.mock.calls[0]?.[0];
    expect(autocompleteOptions).toMatchObject({
      initialValue: "one",
      maxItems: 10,
      message: "Search:",
    });
    expect(autocompleteOptions.filter("special", autocompleteOptions.options[0])).toBe(true);
    expect(autocompleteOptions.filter("missing", autocompleteOptions.options[0])).toBe(false);

    expect(prompts.multiselect.mock.calls[0]?.[0]).toMatchObject({
      initialValues: ["one"],
      maxItems: 10,
      message: "Values:",
      required: false,
    });
  });

  it("uses a stderr Clack spinner only for interactive tasks and always clears it", async () => {
    restoreTerminalProperties = overrideTerminalProperties({ stdinTty: true, stdoutTty: true });

    await expect(runTask("Reading worktrees", async () => "done")).resolves.toBe("done");

    expect(prompts.spinnerFactory).toHaveBeenCalledWith({
      output: process.stderr,
      withGuide: false,
    });
    expect(prompts.spinner.start).toHaveBeenCalledWith("Reading worktrees");
    expect(prompts.spinner.clear).toHaveBeenCalledOnce();

    prompts.spinner.clear.mockReset();
    await expect(
      runTask("Failing task", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(prompts.spinner.clear).toHaveBeenCalledOnce();
  });

  it("does not create a spinner for non-interactive tasks", async () => {
    restoreTerminalProperties = overrideTerminalProperties({ stdinTty: false, stdoutTty: false });

    await expect(runTask("Reading worktrees", async () => "done")).resolves.toBe("done");

    expect(prompts.spinnerFactory).not.toHaveBeenCalled();
  });

  it("renders interactive statuses through Clack without leading spacing", async () => {
    await printStatus("warning", "Review this state");

    expect(prompts.log.warn).toHaveBeenCalledWith("Review this state", {
      output: process.stdout,
      spacing: 0,
    });
  });
});

async function resolveAfterKeypress(
  input: string,
  key: { name?: string; ctrl?: boolean },
): Promise<symbol> {
  return await new Promise((resolve) => {
    queueMicrotask(() => {
      process.stdin.emit("keypress", input, key);
      resolve(prompts.cancelValue);
    });
  });
}

function overrideTerminalProperties(options: {
  stdinTty: boolean;
  stdoutTty: boolean;
}): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: options.stdinTty,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: options.stdoutTty,
  });
  return () => {
    restoreProperty(process.stdin, "isTTY", stdinDescriptor);
    restoreProperty(process.stdout, "isTTY", stdoutDescriptor);
  };
}

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}
