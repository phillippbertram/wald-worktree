import { WaldError } from "../domain/errors.js";

export type SupportedShell = "bash" | "zsh" | "fish";

export class ShellService {
  render(shell: string): string {
    switch (shell) {
      case "bash":
        return bashScript();
      case "zsh":
        return zshScript();
      case "fish":
        return fishScript();
      default:
        throw new WaldError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
    }
  }
}

function bashScript(): string {
  return `# wald navigation integration for bash
wald() {
  if [ "\${1-}" = "cd" ]; then
    shift
    local target
    target="$(command wald cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if { [ "\${1-}" = "create" ] || [ "\${1-}" = "plant" ] || [ "\${1-}" = "handoff" ]; } && [[ " $* " == *" --cd "* ]]; then
    local target
    target="$(command wald "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command wald "$@"
}
`;
}

function zshScript(): string {
  return `# wald navigation integration for zsh
function wald() {
  if [[ "\${1-}" == "cd" ]]; then
    shift
    local target
    target="$(command wald cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [[ ( "\${1-}" == "create" || "\${1-}" == "plant" || "\${1-}" == "handoff" ) && " $* " == *" --cd "* ]]; then
    local target
    target="$(command wald "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command wald "$@"
}
`;
}

function fishScript(): string {
  return `# wald navigation integration for fish
function wald
  if test (count $argv) -ge 1; and test $argv[1] = cd
    set -l target (command wald cd $argv[2..-1]); or return $status
    builtin cd $target; or return $status
    return
  end
  if test (count $argv) -ge 1; and contains -- $argv[1] create plant handoff; and contains -- --cd $argv
    set -l target (command wald $argv --print-path); or return $status
    builtin cd $target; or return $status
    return
  end
  command wald $argv
end
`;
}
