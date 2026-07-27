#!/usr/bin/env sh

set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir="$HOME/.config/opencode"

mkdir -p "$target_dir"

link_path() {
  src=$1
  dest=$2

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      printf 'ok  %s -> %s\n' "$dest" "$src"
      return 0
    fi

    printf 'skip existing %s\n' "$dest" >&2
    return 0
  fi

  ln -s "$src" "$dest"
  printf 'link %s -> %s\n' "$dest" "$src"
}

link_path "$repo_dir/opencode.jsonc" "$target_dir/opencode.json"
link_path "$repo_dir/agents" "$target_dir/agents"
link_path "$repo_dir/commands" "$target_dir/commands"
link_path "$repo_dir/instructions" "$target_dir/instructions"
link_path "$repo_dir/profiles" "$target_dir/profiles"
link_path "$repo_dir/skills" "$target_dir/skills"
printf '\nInstalled shared opencode config into %s\n' "$target_dir"
