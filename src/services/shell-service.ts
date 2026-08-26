import { WtError } from "../domain/errors.js";

export type SupportedShell = "bash" | "zsh" | "fish";

const commands = [
  "init",
  "create",
  "list",
  "cd",
  "open",
  "exec",
  "run",
  "setup",
  "remove",
  "config",
  "shell-init",
];

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
        throw new WtError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
    }
  }
}

function bashScript(): string {
  return `# wt shell integration for bash
wt() {
  if [ "\${1-}" = "cd" ]; then
    shift
    local target
    target="$(command wt cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [ "\${1-}" = "create" ] && [[ " $* " == *" --cd "* ]]; then
    local target
    target="$(command wt "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command wt "$@"
}

_wt_complete() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$current") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
    create) COMPREPLY=( $(compgen -W "$(command wt completion branches)" -- "$current") ) ;;
    cd|open|remove|exec|setup) COMPREPLY=( $(compgen -W "$(command wt completion worktrees)" -- "$current") ) ;;
    run) COMPREPLY=( $(compgen -W "$(command wt completion tasks)" -- "$current") ) ;;
  esac
}
complete -F _wt_complete wt
`;
}

function zshScript(): string {
  return `# wt shell integration for zsh
function wt() {
  if [[ "\${1-}" == "cd" ]]; then
    shift
    local target
    target="$(command wt cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [[ "\${1-}" == "create" && " $* " == *" --cd "* ]]; then
    local target
    target="$(command wt "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command wt "$@"
}

function _wt_complete() {
  if (( CURRENT == 2 )); then
    compadd -- ${commands.join(" ")}
    return
  fi
  case "$words[2]" in
    create) compadd -- \${(f)"$(command wt completion branches)"} ;;
    cd|open|remove|exec|setup) compadd -- \${(f)"$(command wt completion worktrees)"} ;;
    run) compadd -- \${(f)"$(command wt completion tasks)"} ;;
  esac
}
compdef _wt_complete wt
`;
}

function fishScript(): string {
  return `# wt shell integration for fish
function wt
  if test (count $argv) -ge 1; and test $argv[1] = cd
    set -l target (command wt cd $argv[2..-1]); or return $status
    builtin cd $target; or return $status
    return
  end
  if test (count $argv) -ge 1; and test $argv[1] = create; and contains -- --cd $argv
    set -l target (command wt $argv --print-path); or return $status
    builtin cd $target; or return $status
    return
  end
  command wt $argv
end

complete -c wt -f -n '__fish_use_subcommand' -a '${commands.join(" ")}'
complete -c wt -f -n '__fish_seen_subcommand_from create' -a '(command wt completion branches)'
complete -c wt -f -n '__fish_seen_subcommand_from cd open remove exec setup' -a '(command wt completion worktrees)'
complete -c wt -f -n '__fish_seen_subcommand_from run' -a '(command wt completion tasks)'
`;
}
