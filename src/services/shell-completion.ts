import { WaldError } from "../domain/errors.js";

export function renderShellCompletion(shell: string): string {
  switch (shell) {
    case "bash":
      return bashCompletion;
    case "zsh":
      return zshCompletion;
    case "fish":
      return fishCompletion;
    default:
      throw new WaldError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
  }
}

const bashCompletion = `# bash completion for wald
__wald_complete() {
  local cur prev cword wald_out wald_line wald_candidate wald_prefix=""
  local -a words wald_args
  if declare -F _get_comp_words_by_ref >/dev/null; then
    _get_comp_words_by_ref -n =: cur prev words cword
  else
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
    cur="\${words[cword]}"
  fi
  wald_args=("\${words[@]:1:cword}")
  wald_out=$(command wald complete --shell bash -- "\${wald_args[@]}" 2>/dev/null) || return
  case "$cur" in --*=*) wald_prefix="\${cur%%=*}=" ;; esac
  COMPREPLY=()
  while IFS= read -r wald_line; do
    case "$wald_line" in :*|'') continue ;; esac
    wald_candidate="\${wald_line%%$'\\t'*}"
    if [ -n "$wald_prefix" ] && [[ "$wald_candidate" != "$wald_prefix"* ]]; then
      wald_candidate="$wald_prefix$wald_candidate"
    fi
    if [ -n "$wald_prefix" ] && [[ "$COMP_WORDBREAKS" == *"="* ]]; then
      wald_candidate="\${wald_candidate#"$wald_prefix"}"
    fi
    COMPREPLY+=("$wald_candidate")
  done <<< "$wald_out"
}
complete -o filenames -F __wald_complete wald
`;

const zshCompletion = `# zsh completion for wald
_wald() {
  local wald_out wald_line wald_candidate wald_description wald_prefix=""
  local -a wald_args wald_values wald_directories
  wald_args=("\${(@Q)words[2,CURRENT]}")
  wald_out=$(command wald complete -- "\${wald_args[@]}" 2>/dev/null) || return
  case "\${words[CURRENT]}" in --*=*) wald_prefix="\${words[CURRENT]%%=*}=" ;; esac
  for wald_line in "\${(@f)wald_out}"; do
    case "$wald_line" in :*|'') continue ;; esac
    wald_candidate="\${wald_line%%$'\\t'*}"
    wald_description="\${wald_line#*$'\\t'}"
    if [[ -n "$wald_prefix" && "$wald_candidate" != "$wald_prefix"* ]]; then
      wald_candidate="$wald_prefix$wald_candidate"
    fi
    if [[ "$wald_candidate" == */ ]]; then
      wald_directories+=("$wald_candidate")
    else
      wald_values+=("\${wald_candidate//:/\\\\:}:$wald_description")
    fi
  done
  (( \${#wald_directories} )) && compadd -S '' -a wald_directories
  (( \${#wald_values} )) && _describe 'wald' wald_values
  return 0
}
compdef _wald wald
`;

const fishCompletion = `# fish completion for wald
function __wald_complete
  set -l wald_args (commandline -opc)
  set -l wald_current (commandline -ct)
  set -l wald_prefix (string match -r -- '^--[^=]*=' "$wald_current")
  command wald complete -- $wald_args[2..-1] "$wald_current" 2>/dev/null | while read -l wald_line
    if string match -qr -- '^:|^$' "$wald_line"
      continue
    end
    if test -n "$wald_prefix"; and not string match -q -- "$wald_prefix*" "$wald_line"
      printf '%s%s\\n' "$wald_prefix" "$wald_line"
    else
      printf '%s\\n' "$wald_line"
    end
  end
end
complete -c wald -f -a '(__wald_complete)'
`;
