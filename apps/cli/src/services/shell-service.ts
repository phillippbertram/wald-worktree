import { WaldError } from "../domain/errors.js";
import { renderShellCompletion } from "./shell-completion.js";

export type SupportedShell = "bash" | "zsh" | "fish";

export class ShellService {
  renderCompletion(shell: string): string {
    return renderShellCompletion(shell);
  }

  render(shell: string): string {
    switch (shell) {
      case "bash":
      case "zsh":
        return posixScript(shell);
      case "fish":
        return fishScript();
      default:
        throw new WaldError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
    }
  }
}

function posixScript(shell: "bash" | "zsh"): string {
  return `# wald navigation integration for ${shell}
wald() {
  local wald_subcommand="" wald_navigate=0 wald_value=0 wald_end=0 wald_help=0 wald_token wald_target
  local -a wald_create_args=()
  for wald_token in "$@"; do
    wald_create_args+=("$wald_token")
    if [ "$wald_value" = 1 ]; then wald_value=0; continue; fi
    if [ "$wald_end" = 1 ]; then continue; fi
    case "$wald_token" in
      --) wald_end=1 ;;
      -C|--directory|--from|--name|--tool) wald_value=1 ;;
      -C?*|--directory=*|--from=*|--name=*|--tool=*) ;;
      -h|--help|-V|--version) wald_help=1 ;;
      --cd) wald_navigate=1 ;;
      -*) ;;
      *)
        if [ -z "$wald_subcommand" ]; then
          wald_subcommand="$wald_token"
          wald_create_args+=("--print-path")
        fi
        ;;
    esac
  done
  if [ "$wald_help" = 1 ]; then command wald "$@"; return $?; fi
  if [ "$wald_subcommand" = cd ]; then
    wald_target="$(command wald "$@")" || return $?
    builtin cd -- "$wald_target" || return $?
    return
  fi
  if [ "$wald_navigate" = 1 ]; then
    case "$wald_subcommand" in
      create|plant|handoff)
        wald_target="$(command wald "\${wald_create_args[@]}")" || return $?
        builtin cd -- "$wald_target" || return $?
        return
        ;;
    esac
  fi
  command wald "$@"
}
`;
}

function fishScript(): string {
  return `# wald navigation integration for fish
function wald
  set -l wald_subcommand ""
  set -l wald_navigate 0
  set -l wald_value 0
  set -l wald_end 0
  set -l wald_help 0
  set -l wald_create_args
  for wald_token in $argv
    set -a wald_create_args "$wald_token"
    if test $wald_value = 1
      set wald_value 0
      continue
    end
    if test $wald_end = 1
      continue
    end
    switch "$wald_token"
      case --
        set wald_end 1
      case -C --directory --from --name --tool
        set wald_value 1
      case '-C?*' '--directory=*' '--from=*' '--name=*' '--tool=*'
      case -h --help -V --version
        set wald_help 1
      case --cd
        set wald_navigate 1
      case '-*'
      case '*'
        if test -z "$wald_subcommand"
          set wald_subcommand "$wald_token"
          set -a wald_create_args --print-path
        end
    end
  end
  if test $wald_help = 1
    command wald $argv
    return $status
  end
  if test "$wald_subcommand" = cd
    set -l wald_target (command wald $argv); or return $status
    builtin cd -- "$wald_target"; or return $status
    return
  end
  if test $wald_navigate = 1; and contains -- "$wald_subcommand" create plant handoff
    set -l wald_target (command wald $wald_create_args); or return $status
    builtin cd -- "$wald_target"; or return $status
    return
  end
  command wald $argv
end
`;
}
