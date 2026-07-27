#!/usr/bin/env sh

set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir="$HOME/.config/opencode"
force=0

while [ "$#" -gt 0 ]; do
  case $1 in
    --force)
      force=1
      ;;
    -h|--help)
      printf 'Usage: %s [--force]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

mkdir -p "$target_dir"

backup_existing() {
  dest=$1
  ts=$(date +%Y%m%d-%H%M%S)
  backup="$dest.backup-$ts"
  i=1

  while [ -e "$backup" ] || [ -L "$backup" ]; do
    backup="$dest.backup-$ts-$i"
    i=$((i + 1))
  done

  mv "$dest" "$backup"
  printf 'backup %s -> %s\n' "$dest" "$backup"
}

link_path() {
  src=$1
  dest=$2

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      printf 'ok  %s -> %s\n' "$dest" "$src"
      return 0
    fi

    if [ "$force" -eq 1 ]; then
      backup_existing "$dest"
    else
      printf 'skip existing %s\n' "$dest" >&2
      return 0
    fi
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
