// Lab helper of M0.11 (N01, N03; A4 L14). Never shipped. Compiled into the scratch folder with the
// .NET Framework's csc.exe by `lab.ts build-helper`.
//
//   console-ctrl list                 every process: pid, parent pid, exe name, creation time
//                                     (FILETIME, "0" when it cannot be read) as one JSON array
//   console-ctrl send <pid> c|break   attach to <pid>'s console and send Ctrl+C or Ctrl+Break
//   console-ctrl run <exe> [args...]  re-enable Ctrl+C (a parent started with
//                                     CREATE_NEW_PROCESS_GROUP passes "Ctrl+C ignored" on to every
//                                     descendant), then run <exe> with the same stdio and exit code
//   console-ctrl selftest             the send decision on synthetic process lists (no console)
//
// What `send` checks: after attaching, it reads the console's process list once and refuses
// (exit 3) when that list holds a process that is not <pid>, a descendant of <pid> or the helper
// itself. It also refuses (exit 6) when the list cannot be read (GetConsoleProcessList returns 0)
// or does not fit its buffer. What it cannot do: a process that attaches to the console between
// that check and the broadcast still gets the event, and GenerateConsoleCtrlEvent with group 0
// goes to every process on the console: it cannot be limited to one process group. It is a lab
// tool for consoles the lab's own children created. M6.04h: the product creates and owns the
// run's console itself, checks every API result, keeps each process's identity as PID plus
// creation time, and tests the refusal for a foreign console.
// Exit codes: 0 sent, 2 usage, 3 foreign process on the console, 4 AttachConsole failed,
// 5 GenerateConsoleCtrlEvent failed, 6 the console's process list could not be read.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class ConsoleCtrl
{
    const uint TH32CS_SNAPPROCESS = 0x2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetConsoleProcessList(uint[] list, uint count);

    delegate bool Handler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(Handler handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", EntryPoint = "SetConsoleCtrlHandler", SetLastError = true)]
    static extern bool SetConsoleCtrlIgnore(IntPtr handler, bool ignore);

    // Kept in a static field so the garbage collector never frees the delegate.
    static readonly Handler Ignore = t => true;

    struct Proc
    {
        public uint Pid;
        public uint Ppid;
        public string Exe;
    }

    // The creation time of a process as a FILETIME, or 0 when it cannot be opened or read.
    static long CreationTime(uint pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return 0;
        long creation, exit, kernel, user;
        bool ok = GetProcessTimes(h, out creation, out exit, out kernel, out user);
        CloseHandle(h);
        return ok ? creation : 0;
    }

    static List<Proc> Snapshot()
    {
        var result = new List<Proc>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == new IntPtr(-1)) return result;
        var entry = new PROCESSENTRY32W();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
        if (Process32FirstW(snap, ref entry))
        {
            do
            {
                result.Add(new Proc { Pid = entry.th32ProcessID, Ppid = entry.th32ParentProcessID, Exe = entry.szExeFile });
            } while (Process32NextW(snap, ref entry));
        }
        CloseHandle(snap);
        return result;
    }

    static string Json(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append(' ');
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    // Windows command-line quoting (CommandLineToArgvW rules) for one argument.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1).Append('"');
            else b.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return b.Append('\\', slashes * 2).Append('"').ToString();
    }

    static bool DescendsFrom(uint pid, uint root, Dictionary<uint, uint> parent)
    {
        var seen = new HashSet<uint>();
        uint cur = pid;
        while (seen.Add(cur))
        {
            if (cur == root) return true;
            uint up;
            if (!parent.TryGetValue(cur, out up) || up == 0) return false;
            cur = up;
        }
        return false;
    }

    enum Verdict { Send, RefuseForeign, RefuseList }

    // The send decision. `n` is GetConsoleProcessList's return value: 0 is a failure, and a value
    // above the buffer's capacity means the list was not filled. Both refuse.
    static Verdict Decide(uint n, uint[] list, uint self, uint target, Dictionary<uint, uint> parent, out int foreign)
    {
        foreign = 0;
        if (n == 0 || n > list.Length) return Verdict.RefuseList;
        for (int i = 0; i < n; i++)
        {
            uint pid = list[i];
            if (pid != self && !DescendsFrom(pid, target, parent)) foreign++;
        }
        return foreign > 0 ? Verdict.RefuseForeign : Verdict.Send;
    }

    static string SelfTest()
    {
        // target 100 with child 101; the helper is 200; 300 is unrelated.
        var parent = new Dictionary<uint, uint> { { 100, 1 }, { 101, 100 }, { 200, 5 }, { 300, 1 } };
        int f;
        var names = new[] { "zero", "overflow", "foreign", "own" };
        var counts = new[] { 0u, 9u, 3u, 3u };
        var lists = new[] {
            new uint[4],
            new uint[] { 100, 101, 200, 0 },
            new uint[] { 100, 300, 200, 0 },
            new uint[] { 100, 101, 200, 0 },
        };
        var b = new StringBuilder("{");
        for (int i = 0; i < names.Length; i++)
        {
            if (i > 0) b.Append(',');
            var v = Decide(counts[i], lists[i], 200, 100, parent, out f);
            b.Append(Json(names[i])).Append(':').Append(Json(v.ToString()));
        }
        return b.Append("}\n").ToString();
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "selftest")
        {
            Console.Out.Write(SelfTest());
            return 0;
        }
        if (args.Length == 1 && args[0] == "list")
        {
            var b = new StringBuilder("[");
            bool first = true;
            foreach (var p in Snapshot())
            {
                if (!first) b.Append(',');
                first = false;
                b.Append("[").Append(p.Pid).Append(',').Append(p.Ppid).Append(',').Append(Json(p.Exe))
                    .Append(",\"").Append(CreationTime(p.Pid)).Append("\"]");
            }
            Console.Out.Write(b.Append("]\n").ToString());
            return 0;
        }
        if (args.Length >= 2 && args[0] == "run")
        {
            // NULL handler with FALSE: this process, and so its children, handle Ctrl+C again.
            SetConsoleCtrlIgnore(IntPtr.Zero, false);
            var psi = new System.Diagnostics.ProcessStartInfo(args[1]);
            var rest = new StringBuilder();
            for (int i = 2; i < args.Length; i++)
            {
                if (i > 2) rest.Append(' ');
                rest.Append(Quote(args[i]));
            }
            psi.Arguments = rest.ToString();
            psi.UseShellExecute = false;
            // Ctrl+C reaches the helper too: ignore it here, the child decides.
            SetConsoleCtrlHandler(Ignore, true);
            using (var child = System.Diagnostics.Process.Start(psi))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        if (args.Length != 3 || args[0] != "send" || (args[2] != "c" && args[2] != "break"))
        {
            Console.Error.WriteLine("usage: console-ctrl list | selftest | run <exe> [args] | send <pid> c|break");
            return 2;
        }
        uint target = uint.Parse(args[1]);
        uint ctrlEvent = args[2] == "break" ? 1u : 0u;
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        var parent = new Dictionary<uint, uint>();
        foreach (var p in Snapshot()) parent[p.Pid] = p.Ppid;

        // Leave the helper's own console, then join the agent's.
        FreeConsole();
        if (!AttachConsole(target))
        {
            int err = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("{\"attached\":false,\"error\":" + err + "}");
            return 4;
        }
        var list = new uint[256];
        uint n = GetConsoleProcessList(list, (uint)list.Length);
        // A process that started after the snapshot is looked up in a fresh one.
        foreach (var p in Snapshot()) parent[p.Pid] = p.Ppid;
        int foreign;
        var verdict = Decide(n, list, self, target, parent, out foreign);
        if (verdict == Verdict.RefuseList)
        {
            FreeConsole();
            Console.Error.WriteLine("{\"attached\":true,\"sent\":false,\"list_failed\":true}");
            return 6;
        }
        if (verdict == Verdict.RefuseForeign)
        {
            FreeConsole();
            Console.Error.WriteLine("{\"attached\":true,\"sent\":false,\"foreign\":" + foreign + "}");
            return 3;
        }
        SetConsoleCtrlHandler(Ignore, true);
        bool ok = GenerateConsoleCtrlEvent(ctrlEvent, 0);
        int genErr = Marshal.GetLastWin32Error();
        Thread.Sleep(250);
        FreeConsole();
        Console.Error.WriteLine("{\"attached\":true,\"sent\":" + (ok ? "true" : "false") + ",\"console_processes\":" + n + (ok ? "" : ",\"error\":" + genErr) + "}");
        return ok ? 0 : 5;
    }
}
