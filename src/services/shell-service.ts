import { YggError } from "../domain/errors.js";

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
  "prune",
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
        throw new YggError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
    }
  }
}

function bashScript(): string {
  return `# ygg shell integration for bash
ygg() {
  if [ "\${1-}" = "cd" ]; then
    shift
    local target
    target="$(command ygg cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [ "\${1-}" = "create" ] && [[ " $* " == *" --cd "* ]]; then
    local target
    target="$(command ygg "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command ygg "$@"
}

_ygg_complete() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$current") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
    create) COMPREPLY=( $(compgen -W "$(command ygg completion branches)" -- "$current") ) ;;
    cd|open|remove|exec|setup) COMPREPLY=( $(compgen -W "$(command ygg completion worktrees)" -- "$current") ) ;;
    run) COMPREPLY=( $(compgen -W "$(command ygg completion tasks)" -- "$current") ) ;;
    config)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "init trust untrust" -- "$current") )
      elif [ "\${COMP_WORDS[2]}" = "init" ]; then
        COMPREPLY=( $(compgen -W "$(command ygg completion worktrees)" -- "$current") )
      fi
      ;;
  esac
}
complete -F _ygg_complete ygg
`;
}

function zshScript(): string {
  return `# ygg shell integration for zsh
function ygg() {
  if [[ "\${1-}" == "cd" ]]; then
    shift
    local target
    target="$(command ygg cd "$@")" || return $?
    builtin cd "$target" || return $?
    return
  fi
  if [[ "\${1-}" == "create" && " $* " == *" --cd "* ]]; then
    local target
    target="$(command ygg "$@" --print-path)" || return $?
    builtin cd "$target" || return $?
    return
  fi
  command ygg "$@"
}

function _ygg_complete() {
  if (( CURRENT == 2 )); then
    compadd -- ${commands.join(" ")}
    return
  fi
  case "$words[2]" in
    create) compadd -- \${(f)"$(command ygg completion branches)"} ;;
    cd|open|remove|exec|setup) compadd -- \${(f)"$(command ygg completion worktrees)"} ;;
    run) compadd -- \${(f)"$(command ygg completion tasks)"} ;;
    config)
      if (( CURRENT == 3 )); then
        compadd -- init trust untrust
      elif [[ "$words[3]" == "init" ]]; then
        compadd -- \${(f)"$(command ygg completion worktrees)"}
      fi
      ;;
  esac
}
compdef _ygg_complete ygg
`;
}

function fishScript(): string {
  return `# ygg shell integration for fish
function ygg
  if test (count $argv) -ge 1; and test $argv[1] = cd
    set -l target (command ygg cd $argv[2..-1]); or return $status
    builtin cd $target; or return $status
    return
  end
  if test (count $argv) -ge 1; and test $argv[1] = create; and contains -- --cd $argv
    set -l target (command ygg $argv --print-path); or return $status
    builtin cd $target; or return $status
    return
  end
  command ygg $argv
end

complete -c ygg -f -n '__fish_use_subcommand' -a '${commands.join(" ")}'
complete -c ygg -f -n '__fish_seen_subcommand_from create' -a '(command ygg completion branches)'
complete -c ygg -f -n '__fish_seen_subcommand_from cd open remove exec setup' -a '(command ygg completion worktrees)'
complete -c ygg -f -n '__fish_seen_subcommand_from run' -a '(command ygg completion tasks)'
complete -c ygg -f -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from init trust untrust' -a 'init trust untrust'
complete -c ygg -f -n '__fish_seen_subcommand_from config; and __fish_seen_subcommand_from init' -a '(command ygg completion worktrees)'
`;
}
