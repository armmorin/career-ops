# Prepend the directories that hold node, npx, uvx, and bun.
# Existing PATH entries stay, so a later spawn does not lose them.
prepend_path() {
  case ":${PATH}:" in
    *":$1:"*) ;;
    *) PATH="$1${PATH:+:$PATH}" ;;
  esac
}
prepend_path "${HOME}/.bun/bin"
prepend_path "${HOME}/.local/bin"
export PATH
