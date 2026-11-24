"""Report processes with open handles in a failed Windows CI test world."""

import ctypes as c
import os
import subprocess
import sys
from ctypes import wintypes as w
from pathlib import Path


kernel = c.WinDLL("kernel32", use_last_error=True)
kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
kernel.CreateFileW.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
query = c.WinDLL("ntdll").NtQueryInformationFile
query.argtypes = [w.HANDLE, w.LPVOID, w.LPVOID, w.ULONG, w.ULONG]


def open_pids(path):
    # Read attributes, share read/write/delete, open existing directories and reparse points.
    handle = kernel.CreateFileW(str(path), 0x80, 7, None, 3, 0x02200000, None)
    if handle == w.HANDLE(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        result = c.create_string_buffer(32768)
        io_status = (c.c_size_t * 2)()
        # FileProcessIdsUsingFileInformation returns a count and a pointer-aligned PID array.
        status = query(handle, c.byref(io_status), result, len(result), 47)
        if status:
            raise OSError(f"NTSTATUS {status & 0xffffffff:#x}")
        count = w.ULONG.from_buffer(result).value
        pids = (c.c_size_t * count).from_buffer(result, c.sizeof(c.c_size_t))
        return set(pids) - {os.getpid()}
    finally:
        kernel.CloseHandle(handle)


root = Path(sys.argv[1])
owners = set()
for base, children, files in root.walk():
    children[:] = [name for name in children if not (base / name).is_junction()]
    for path in [base, *(base / name for name in files)]:
        try:
            for pid in open_pids(path):
                owners.add(pid)
                print(f"Open handle: PID {pid}, {path.relative_to(root)}", flush=True)
        except FileNotFoundError:
            pass
        except OSError as error:
            print(f"Handle query failed for {path.relative_to(root)}: {error.strerror or error}")

if owners:
    # A node.exe PID can be the worker, service, window, shim or agent. Print only its role.
    filters = " OR ".join(f"ProcessId={pid}" for pid in sorted(owners))
    script = r"""
Get-CimInstance Win32_Process -Filter $env:TTASKS_HANDLE_PIDS | ForEach-Object {
  $role = switch -Regex ($_.CommandLine) {
    '[/\\]fakes[/\\]terminal\.ts' { 'fake terminal'; break }
    '[/\\]fakes[/\\]cli-agent\.ts' { 'fake agent'; break }
    '[/\\]serve-entry\.ts' { 'test service'; break }
    '\s"?shim"?\s' { 'shim'; break }
    'playwright' { 'browser or test runner'; break }
  }
  Write-Output "PID $($_.ProcessId), $($_.Name), parent $($_.ParentProcessId) $role"
}
"""
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env={**os.environ, "TTASKS_HANDLE_PIDS": filters},
        check=True,
    )
else:
    print("No open handle observed in the remaining test world.")
