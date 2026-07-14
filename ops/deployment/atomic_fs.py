#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import secrets
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Durable deployment filesystem operations")
    parser.add_argument("--allowed-root", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    write_parser = subparsers.add_parser("write-file")
    write_parser.add_argument("destination")
    write_parser.add_argument("mode")

    symlink_parser = subparsers.add_parser("replace-symlink")
    symlink_parser.add_argument("destination")
    symlink_parser.add_argument("target")

    clear_parser = subparsers.add_parser("clear-file")
    clear_parser.add_argument("destination")

    return parser.parse_args()


def validate_root(root_argument: str) -> str:
    if not os.path.isabs(root_argument):
        raise ValueError("allowed root must be absolute")
    root = os.path.normpath(root_argument)
    if os.path.realpath(root) != root:
        raise ValueError("allowed root must not traverse symlinks")
    metadata = os.lstat(root)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("allowed root must be a directory")
    return root


def destination_parts(root: str, destination_argument: str) -> tuple[list[str], str]:
    if not os.path.isabs(destination_argument):
        raise ValueError("destination must be absolute")
    destination = os.path.normpath(destination_argument)
    if os.path.commonpath((root, destination)) != root or destination == root:
        raise ValueError("destination escapes allowed root")
    relative = os.path.relpath(destination, root)
    parts = relative.split(os.sep)
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("destination path is invalid")
    return parts[:-1], parts[-1]


@contextmanager
def open_parent(root: str, parent_parts: list[str]) -> Iterator[int]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in parent_parts:
            next_descriptor = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        yield descriptor
    finally:
        os.close(descriptor)


def destination_metadata(parent_descriptor: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return None


def parse_mode(mode_text: str) -> int:
    if len(mode_text) != 4 or mode_text[0] != "0" or any(char not in "01234567" for char in mode_text):
        raise ValueError("mode must be a four-digit octal value")
    mode = int(mode_text, 8)
    if mode & (stat.S_IWGRP | stat.S_IWOTH | stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
        raise ValueError("mode grants unsafe permissions")
    return mode


def temporary_name(destination_name: str) -> str:
    return f".{destination_name}.{secrets.token_hex(16)}.tmp"


def write_all(descriptor: int, contents: bytes) -> None:
    offset = 0
    while offset < len(contents):
        offset += os.write(descriptor, contents[offset:])


def write_file(root: str, destination: str, mode_text: str) -> None:
    parent_parts, destination_name = destination_parts(root, destination)
    mode = parse_mode(mode_text)
    contents = sys.stdin.buffer.read()
    with open_parent(root, parent_parts) as parent_descriptor:
        existing = destination_metadata(parent_descriptor, destination_name)
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise ValueError("destination is not a regular file")

        temporary = temporary_name(destination_name)
        descriptor = -1
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                mode,
                dir_fd=parent_descriptor,
            )
            os.fchmod(descriptor, mode)
            write_all(descriptor, contents)
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            os.replace(
                temporary,
                destination_name,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
            )
            durable_descriptor = os.open(
                destination_name,
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=parent_descriptor,
            )
            try:
                os.fsync(durable_descriptor)
            finally:
                os.close(durable_descriptor)
            os.fsync(parent_descriptor)
        except BaseException:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=parent_descriptor)
            except FileNotFoundError:
                pass
            raise


def validate_symlink_target(root: str, destination: str, target: str) -> None:
    if os.path.isabs(target) or not target or "\x00" in target:
        raise ValueError("symlink target must be relative")
    candidate = os.path.normpath(os.path.join(os.path.dirname(destination), target))
    if os.path.commonpath((root, candidate)) != root:
        raise ValueError("symlink target escapes allowed root")
    resolved = os.path.realpath(candidate)
    if os.path.commonpath((root, resolved)) != root or not os.path.exists(resolved):
        raise ValueError("symlink target is missing or escapes through a symlink")


def replace_symlink(root: str, destination: str, target: str) -> None:
    parent_parts, destination_name = destination_parts(root, destination)
    validate_symlink_target(root, os.path.normpath(destination), target)
    with open_parent(root, parent_parts) as parent_descriptor:
        existing = destination_metadata(parent_descriptor, destination_name)
        if existing is not None and not stat.S_ISLNK(existing.st_mode):
            raise ValueError("destination is not a symlink")

        temporary = temporary_name(destination_name)
        try:
            os.symlink(target, temporary, dir_fd=parent_descriptor)
            os.replace(
                temporary,
                destination_name,
                src_dir_fd=parent_descriptor,
                dst_dir_fd=parent_descriptor,
            )
            os.fsync(parent_descriptor)
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=parent_descriptor)
            except FileNotFoundError:
                pass
            raise


def clear_file(root: str, destination: str) -> None:
    parent_parts, destination_name = destination_parts(root, destination)
    with open_parent(root, parent_parts) as parent_descriptor:
        existing = destination_metadata(parent_descriptor, destination_name)
        if existing is None:
            os.fsync(parent_descriptor)
            return
        if not stat.S_ISREG(existing.st_mode):
            raise ValueError("destination is not a regular file")

        descriptor = os.open(
            destination_name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=parent_descriptor,
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.unlink(destination_name, dir_fd=parent_descriptor)
        os.fsync(parent_descriptor)


def main() -> int:
    arguments = parse_arguments()
    try:
        root = validate_root(arguments.allowed_root)
        if arguments.command == "write-file":
            write_file(root, arguments.destination, arguments.mode)
        elif arguments.command == "replace-symlink":
            replace_symlink(root, arguments.destination, arguments.target)
        elif arguments.command == "clear-file":
            clear_file(root, arguments.destination)
        else:
            raise ValueError("unsupported command")
    except (OSError, ValueError):
        print("atomic filesystem operation failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
