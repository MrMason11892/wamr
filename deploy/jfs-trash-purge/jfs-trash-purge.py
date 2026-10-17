#!/usr/bin/env python3
"""Permanently remove folders the WAMR media janitor deleted from the JuiceFS trash.

JuiceFS keeps deleted files in /mnt/jfs/.trash/<hour>/ for its trash-days. Every file and
folder becomes its own flat entry named "<parent inode>-<inode>-<name>", so a show is its
top folder entry plus everything chained beneath it by inode. The janitor queues the top
folder names; this walks each chain and removes it, leaving the rest of the trash alone.

Runs as root (only root can delete from the trash). Entries stay queued for 2 days, in
case Sonarr/Radarr were still deleting when the purge ran.

Install on emby (once):
  sudo cp /opt/apps/wamr/deploy/jfs-trash-purge/jfs-trash-purge.{service,timer} /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now jfs-trash-purge.timer
"""
import json, os, re, subprocess, sys, time
from collections import defaultdict
from datetime import datetime, timezone

TRASH = os.environ.get("JFS_TRASH", "/mnt/jfs/.trash")
QUEUE = os.environ.get("JANITOR_QUEUE", "/opt/apps/wamr/data/janitor/trash-purge-queue.jsonl")
KEEP_QUEUED_SECONDS = 2 * 86400
ENTRY = re.compile(r"^(\d+)-(\d+)-(.*)$")


def log(msg):
    print(f"[jfs-trash-purge] {msg}", flush=True)


def read_queue():
    items = []
    try:
        with open(QUEUE) as f:
            for line in f:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
    except FileNotFoundError:
        pass
    return items


def scan_trash():
    """Return (top entries by lower-cased name, children by parent inode)."""
    by_name, children = defaultdict(list), defaultdict(list)
    for hour in sorted(os.listdir(TRASH)):
        hour_dir = os.path.join(TRASH, hour)
        if not os.path.isdir(hour_dir):
            continue
        for name in os.listdir(hour_dir):
            m = ENTRY.match(name)
            if not m:
                continue
            parent, ino, base = m.group(1), m.group(2), m.group(3)
            entry = (ino, os.path.join(hour_dir, name))
            by_name[base.lower()].append(entry)
            children[parent].append(entry)
    return by_name, children


def remove(path):
    if os.path.isdir(path) and not os.path.islink(path):
        subprocess.run(["juicefs", "rmr", path], check=True, stdout=subprocess.DEVNULL)
    else:
        os.remove(path)


def main():
    queue = read_queue()
    if not queue:
        return 0
    by_name, children = scan_trash()
    removed, freed = 0, 0
    for item in queue:
        for ino, top in by_name.get(item["folder"].lower(), []):
            # Depth-first, children before parents, so directories are empty by the time we reach them.
            stack, order = [(ino, top)], []
            while stack:
                cur_ino, cur_path = stack.pop()
                order.append(cur_path)
                stack.extend(children.get(cur_ino, []))
            for path in reversed(order):
                try:
                    if not os.path.isdir(path):
                        freed += os.path.getsize(path)
                    remove(path)
                    removed += 1
                except FileNotFoundError:
                    pass
                except Exception as e:  # keep going; the next run retries
                    log(f"could not remove {path}: {e}")
            log(f"purged {item['folder']} ({len(order)} entries)")

    now = time.time()
    keep = [i for i in queue
            if now - datetime.fromisoformat(i["deletedAt"].replace("Z", "+00:00")).timestamp() < KEEP_QUEUED_SECONDS]
    # WAMR appends to this file from its container, so keep its owner and mode.
    st = os.stat(QUEUE)
    tmp = QUEUE + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(json.dumps(i) + "\n" for i in keep)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, QUEUE)
    if removed:
        log(f"removed {removed} trash entries, {freed / 1e9:.1f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
