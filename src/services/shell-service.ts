import { YggError } from "../domain/errors.js";

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
        throw new YggError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
    }
  }
}

function bashScript(): string {
  return `# ygg navigation integration for bash
ygg() {
  if [ "\${1-}" = "cd" ]; then
    shift
    local target
    target="$(command ygg cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if { [ "\${1-}" = "create" ] || [ "\${1-}" = "handoff" ]; } && [[ " $* " == *" --cd "* ]]; then
    local target
    target="$(command ygg "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command ygg "$@"
}
`;
}

function zshScript(): string {
  return `# ygg navigation integration for zsh
function ygg() {
  if [[ "\${1-}" == "cd" ]]; then
    shift
    local target
    target="$(command ygg cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [[ ( "\${1-}" == "create" || "\${1-}" == "handoff" ) && " $* " == *" --cd "* ]]; then
    local target
    target="$(command ygg "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command ygg "$@"
}
`;
}

function fishScript(): string {
  return `# ygg navigation integration for fish
function ygg
  if test (count $argv) -ge 1; and test $argv[1] = cd
    set -l target (command ygg cd $argv[2..-1]); or return $status
    builtin cd $target; or return $status
    return
  end
  if test (count $argv) -ge 1; and contains -- $argv[1] create handoff; and contains -- --cd $argv
    set -l target (command ygg $argv --print-path); or return $status
    builtin cd $target; or return $status
    return
  end
  command ygg $argv
end
`;
}
