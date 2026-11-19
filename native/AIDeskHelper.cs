// AIDeskHelper — single long-lived Windows desktop helper for AI Desktop (C# 5 / .NET Framework 4.x).
// Protocol: JSON lines. stdin  {"id":1,"cmd":"ping",...}
//                      stdout {"id":1,"ok":true,...}   events: {"ev":"rb-end",...}
// Built as AIDeskHelper.exe (mcs, x64) and also loadable from PowerShell 5.1 via Add-Type -Path (fallback).
// Must stay C# 5 compatible (PowerShell 5.1 Add-Type compiler): no $"", ?. , nameof, out var.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AIDesk
{
  // ------------------------------------------------------------------ tiny JSON
  public static class Json
  {
    public static object Parse(string s) { int i = 0; return Val(s, ref i); }
    static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
    static object Val(string s, ref int i)
    {
      Ws(s, ref i);
      if (i >= s.Length) return null;
      char c = s[i];
      if (c == '{')
      {
        var d = new Dictionary<string, object>(); i++;
        Ws(s, ref i);
        if (i < s.Length && s[i] == '}') { i++; return d; }
        while (i < s.Length)
        {
          Ws(s, ref i); string k = Str(s, ref i); Ws(s, ref i); i++; // :
          d[k] = Val(s, ref i); Ws(s, ref i);
          if (i < s.Length && s[i] == ',') { i++; continue; }
          i++; break;
        }
        return d;
      }
      if (c == '[')
      {
        var l = new List<object>(); i++;
        Ws(s, ref i);
        if (i < s.Length && s[i] == ']') { i++; return l; }
        while (i < s.Length)
        {
          l.Add(Val(s, ref i)); Ws(s, ref i);
          if (i < s.Length && s[i] == ',') { i++; continue; }
          i++; break;
        }
        return l;
      }
      if (c == '"') return Str(s, ref i);
      if (s.Length - i >= 4 && s.Substring(i, 4) == "true") { i += 4; return true; }
      if (s.Length - i >= 5 && s.Substring(i, 5) == "false") { i += 5; return false; }
      if (s.Length - i >= 4 && s.Substring(i, 4) == "null") { i += 4; return null; }
      int st = i;
      while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
      double v; double.TryParse(s.Substring(st, i - st), NumberStyles.Float, CultureInfo.InvariantCulture, out v);
      return v;
    }
    static string Str(string s, ref int i)
    {
      var sb = new StringBuilder(); i++;
      while (i < s.Length && s[i] != '"')
      {
        char c = s[i++];
        if (c == '\\' && i < s.Length)
        {
          char e = s[i++];
          switch (e)
          {
            case 'n': sb.Append('\n'); break;
            case 'r': sb.Append('\r'); break;
            case 't': sb.Append('\t'); break;
            case 'b': sb.Append('\b'); break;
            case 'f': sb.Append('\f'); break;
            case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
            default: sb.Append(e); break;
          }
        }
        else sb.Append(c);
      }
      i++;
      return sb.ToString();
    }
    public static string Q(string s)
    {
      if (s == null) return "null";
      var sb = new StringBuilder("\"");
      foreach (char c in s)
      {
        if (c == '"') sb.Append("\\\"");
        else if (c == '\\') sb.Append("\\\\");
        else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
        else sb.Append(c);
      }
      return sb.Append('"').ToString();
    }
  }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }

  // ------------------------------------------------------------------ COM interop
  [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IServiceProvider { [PreserveSig] int QueryService(ref Guid sid, ref Guid iid, out IntPtr ppv); }

  [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellBrowser
  {
    void GetWindow(out IntPtr h); void ContextSensitiveHelp(bool f);
    void InsertMenusSB(IntPtr a, IntPtr b); void SetMenuSB(IntPtr a, IntPtr b, IntPtr c); void RemoveMenusSB(IntPtr a);
    void SetStatusTextSB(IntPtr a); void EnableModelessSB(bool f); void TranslateAcceleratorSB(IntPtr a, ushort b);
    void BrowseObject(IntPtr a, uint b); void GetViewStateStream(uint a, out IntPtr b); void GetControlWindow(uint a, out IntPtr b);
    void SendControlMsg(uint a, uint b, IntPtr c, IntPtr d, out IntPtr e);
    [PreserveSig] int QueryActiveShellView(out IntPtr ppshv);
    void OnViewWindowActive(IntPtr a); void SetToolbarItems(IntPtr a, uint b, uint c);
  }

  [ComImport, Guid("cde725b0-ccc9-4519-917e-325d72fab4ce"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFolderView
  {
    void GetCurrentViewMode(out uint m); void SetCurrentViewMode(uint m);
    [PreserveSig] int GetFolder(ref Guid riid, out IntPtr ppv);
    [PreserveSig] int Item(int i, out IntPtr pidl);
    [PreserveSig] int ItemCount(uint flags, out int n);
    [PreserveSig] int Items(uint flags, ref Guid riid, out IntPtr ppv);
    void GetSelectionMarkedItem(out int i); void GetFocusedItem(out int i);
    [PreserveSig] int GetItemPosition(IntPtr pidl, out POINT pt);
    [PreserveSig] int GetSpacing(ref POINT pt);
    [PreserveSig] int GetDefaultSpacing(out POINT pt);
    [PreserveSig] int GetAutoArrange();
    void SelectItem(int i, uint f); void SelectAndPositionItems(uint c, IntPtr a, IntPtr p, uint f);
  }

  [ComImport, Guid("000214F2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumIDList
  {
    [PreserveSig] int Next(uint celt, out IntPtr rgelt, out uint fetched);
    [PreserveSig] int Skip(uint celt); [PreserveSig] int Reset(); [PreserveSig] int Clone(out IntPtr e);
  }

  [StructLayout(LayoutKind.Explicit, Size = 272)] public struct STRRET { [FieldOffset(0)] public uint uType; }

  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellFolder
  {
    [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, ref uint eaten, out IntPtr pidl, ref uint attrs);
    [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IntPtr e);
    [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr l, IntPtr a, IntPtr b);
    [PreserveSig] int CreateViewObject(IntPtr hwnd, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetAttributesOf(uint cidl, [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint rgf);
    [PreserveSig] int GetUIObjectOf(IntPtr hwnd, uint cidl, [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref Guid riid, IntPtr res, out IntPtr ppv);
    [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, out STRRET name);
    [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string name, uint flags, out IntPtr pidlOut);
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct CMINVOKECOMMANDINFOEX
  {
    public int cbSize; public int fMask; public IntPtr hwnd; public IntPtr lpVerb; public IntPtr lpParameters; public IntPtr lpDirectory;
    public int nShow; public int dwHotKey; public IntPtr hIcon; public IntPtr lpTitle; public IntPtr lpVerbW; public IntPtr lpParametersW;
    public IntPtr lpDirectoryW; public IntPtr lpTitleW; public POINT ptInvoke;
  }

  [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu
  {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr res, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
  }
  [ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu2
  {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr res, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
    [PreserveSig] int HandleMenuMsg(uint msg, IntPtr w, IntPtr l);
  }
  [ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu3
  {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
    [PreserveSig] int GetCommandString(UIntPtr id, uint flags, IntPtr res, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
    [PreserveSig] int HandleMenuMsg(uint msg, IntPtr w, IntPtr l);
    [PreserveSig] int HandleMenuMsg2(uint msg, IntPtr w, IntPtr l, out IntPtr result);
  }

  static class N
  {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct MSLL { public POINT pt; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public POINT p; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; public uint pad1; public uint pad2; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint tid);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint tid, uint m, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string n);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] public static extern bool DestroyMenu(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool InsertMenu(IntPtr h, uint pos, uint flags, UIntPtr id, string text);
    [DllImport("user32.dll")] public static extern int TrackPopupMenuEx(IntPtr h, uint flags, int x, int y, IntPtr wnd, IntPtr tpm);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr addr, UIntPtr size, uint type, uint prot);
    [DllImport("kernel32.dll")] public static extern bool WriteProcessMemory(IntPtr p, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr n);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr p, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr n);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHParseDisplayName(string name, IntPtr pbc, out IntPtr pidl, uint sfgao, out uint attrs);
    [DllImport("shell32.dll")] public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr pidlLast);
    [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] public static extern int StrRetToBuf(ref STRRET s, IntPtr pidl, StringBuilder buf, int cch);
    [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);
    [DllImport("ole32.dll")] public static extern int OleInitialize(IntPtr r);

    public static string Cls(IntPtr h) { var sb = new StringBuilder(64); GetClassName(h, sb, 64); return sb.ToString(); }
  }

  // Window that owns native context menus and forwards owner-draw messages (Send to / Open with submenus).
  class MenuHost : NativeWindow
  {
    public IContextMenu2 cm2; public IContextMenu3 cm3;
    public MenuHost() { var cp = new CreateParams(); cp.Caption = "AIDeskMenuHost"; CreateHandle(cp); }
    protected override void WndProc(ref Message m)
    {
      int msg = m.Msg;
      if (cm3 != null || cm2 != null)
      {
        if (msg == 0x0117 || msg == 0x002B || msg == 0x002C || msg == 0x0120)
        {
          try
          {
            if (cm3 != null) { IntPtr r; if (cm3.HandleMenuMsg2((uint)msg, m.WParam, m.LParam, out r) == 0) { m.Result = r; return; } }
            else if (cm2.HandleMenuMsg((uint)msg, m.WParam, m.LParam) == 0) { m.Result = IntPtr.Zero; return; }
          }
          catch { }
        }
      }
      base.WndProc(ref m);
    }
  }

  public static class Program
  {
    const string VERSION = "1.3.2";
    static readonly object outLock = new object();
    static Control pump;
    static MenuHost host;
    static readonly IntPtr MAGIC = new IntPtr(0x41494453); // 'AIDS' marks our own injected clicks

    static StreamWriter stdout;
    public static void Emit(string json)
    {
      lock (outLock)
      {
        try
        {
          if (stdout == null) { stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); stdout.AutoFlush = true; stdout.NewLine = "\n"; }
          stdout.WriteLine(json);
        }
        catch { }
      }
    }

    [STAThread]
    public static void Main(string[] args) { Run(); }

    public static void Run()
    {
      try { if (!N.SetProcessDpiAwarenessContext(new IntPtr(-4))) N.SetProcessDPIAware(); } catch { try { N.SetProcessDPIAware(); } catch { } }
      try { N.OleInitialize(IntPtr.Zero); } catch { }
      pump = new Control(); pump.CreateControl(); var hh = pump.Handle;
      host = new MenuHost();
      var reader = new Thread(ReadLoop); reader.IsBackground = true; reader.Start();
      Emit("{\"ev\":\"ready\",\"ver\":" + Json.Q(VERSION) + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}");
      Application.Run();
      Cleanup();
    }

    static void ReadLoop()
    {
      var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string line;
      while ((line = stdin.ReadLine()) != null)
      {
        string l = line.Trim();
        if (l.Length == 0) continue;
        string captured = l;
        try { pump.BeginInvoke(new Action(delegate { Handle(captured); })); } catch { }
      }
      try { pump.BeginInvoke(new Action(delegate { Application.ExitThread(); })); } catch { Environment.Exit(0); }
    }

    static void Cleanup()
    {
      try { if (iconsHidden) Icons(true); } catch { }
      StopHook();
    }

    static string S(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null; }
    static double D(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is double ? (double)v : 0; }
    static bool B(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }

    static void Handle(string line)
    {
      Dictionary<string, object> d = null; string id = "null";
      try
      {
        d = Json.Parse(line) as Dictionary<string, object>;
        if (d == null) return;
        object idv; if (d.TryGetValue("id", out idv) && idv is double) id = ((double)idv).ToString(CultureInfo.InvariantCulture);
        string cmd = S(d, "cmd") ?? "";
        string res = Dispatch(cmd, d);
        Emit("{\"id\":" + id + ",\"ok\":true" + (string.IsNullOrEmpty(res) ? "" : "," + res) + "}");
      }
      catch (Exception e)
      {
        Emit("{\"id\":" + id + ",\"ok\":false,\"error\":" + Json.Q(e.GetType().Name + ": " + e.Message) + "}");
      }
    }

    static IntPtr H(Dictionary<string, object> d) { string s = S(d, "hwnd"); long v; return long.TryParse(s, out v) ? new IntPtr(v) : IntPtr.Zero; }

    static string Dispatch(string cmd, Dictionary<string, object> d)
    {
      switch (cmd)
      {
        case "ping": return "\"ver\":" + Json.Q(VERSION) + ",\"x64\":" + (IntPtr.Size == 8 ? "true" : "false");
        case "bottom": N.SetWindowPos(H(d), new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); return "";
        case "attach": { IntPtr hst = DefViewHost(); if (hst == IntPtr.Zero) return "\"result\":\"nohost\""; N.SetParent(H(d), hst); return "\"result\":\"ok\""; }
        case "detach": N.SetParent(H(d), IntPtr.Zero); return "";
        case "icons": Icons(B(d, "show")); return "";
        case "hook":
          dblOn = B(d, "dbl"); ctxApp = B(d, "ctx"); drawBtn = S(d, "draw") ?? "off";
          if (dblOn || ctxApp || drawBtn != "off") StartHook(); else StopHook();
          return "\"active\":" + (hookTid != 0 || dblOn || ctxApp || drawBtn != "off" ? "true" : "false");
        case "items": return Items(B(d, "selected"));
        case "ctxmenu": return CtxMenu(d);
        case "nativeDesktopMenu": Replay(true, (int)D(d, "x"), (int)D(d, "y")); return "";
        case "dirs": return "\"desktop\":" + Json.Q(Known("B4BFCC3A-DB2C-424C-B029-7FE99A87C641")) + ",\"publicDesktop\":" + Json.Q(Known("C4AA340D-F20F-4863-AFEF-F87EF2E6BA25"));
        case "clipset": return ClipSet(d);
        case "clipget": return ClipGet();
        case "quit": Application.ExitThread(); return "";
        default: throw new ArgumentException("unknown cmd " + cmd);
      }
    }

    static string Known(string g)
    {
      Guid id = new Guid(g); IntPtr p;
      if (N.SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out p) != 0) return null;
      string s = Marshal.PtrToStringUni(p); N.CoTaskMemFree(p); return s;
    }

    // ---------------------------------------------------------------- desktop window lookup
    static IntPtr found;
    static bool EnumCb(IntPtr top, IntPtr l) { if (N.FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { found = top; return false; } return true; }
    static readonly N.EnumProc enumCb = EnumCb;
    public static IntPtr DefViewHost()
    {
      IntPtr progman = N.FindWindow("Progman", null); IntPtr r;
      N.SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out r);
      if (N.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) return progman;
      found = IntPtr.Zero; N.EnumWindows(enumCb, IntPtr.Zero); return found;
    }
    static IntPtr DesktopListView()
    {
      IntPtr hst = DefViewHost(); if (hst == IntPtr.Zero) return IntPtr.Zero;
      IntPtr dv = N.FindWindowEx(hst, IntPtr.Zero, "SHELLDLL_DefView", null);
      return N.FindWindowEx(dv, IntPtr.Zero, "SysListView32", null);
    }
    static volatile bool iconsHidden = false;
    static void Icons(bool show)
    {
      IntPtr lv = DesktopListView(); if (lv == IntPtr.Zero) return;
      N.ShowWindow(lv, show ? 5 : 0); iconsHidden = !show;
    }

    // ---------------------------------------------------------------- IFolderView (desktop)
    static readonly Guid SID_STopLevelBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    static readonly Guid IID_IShellBrowser = new Guid("000214E2-0000-0000-C000-000000000046");
    static readonly Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
    static readonly Guid IID_IEnumIDList = new Guid("000214F2-0000-0000-C000-000000000046");
    static readonly Guid IID_IContextMenu = new Guid("000214e4-0000-0000-c000-000000000046");

    static IFolderView DesktopFolderView()
    {
      Type t = Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39"));
      object sw = Activator.CreateInstance(t);
      object loc = 0; object root = null;
      object[] args = new object[] { loc, root, 8 /*SWC_DESKTOP*/, 0, 1 /*SWFO_NEEDDISPATCH*/ };
      var mods = new System.Reflection.ParameterModifier(5); mods[0] = true; mods[1] = true; mods[3] = true;
      object disp = t.InvokeMember("FindWindowSW", System.Reflection.BindingFlags.InvokeMethod, null, sw, args, new[] { mods }, null, null);
      if (disp == null) throw new InvalidOperationException("desktop shell window not found");
      var sp = (IServiceProvider)disp;
      Guid sid = SID_STopLevelBrowser, iid = IID_IShellBrowser; IntPtr pb;
      Marshal.ThrowExceptionForHR(sp.QueryService(ref sid, ref iid, out pb));
      var browser = (IShellBrowser)Marshal.GetObjectForIUnknown(pb); Marshal.Release(pb);
      IntPtr pv; Marshal.ThrowExceptionForHR(browser.QueryActiveShellView(out pv));
      var fv = (IFolderView)Marshal.GetObjectForIUnknown(pv); Marshal.Release(pv);
      return fv;
    }
    // v1.3.2: Explorer-compatible file clipboard (CF_HDROP + Preferred DropEffect) — runs on our STA thread.
    static string ClipSet(Dictionary<string, object> d)
    {
      var files = new System.Collections.Specialized.StringCollection();
      object pv; if (d.TryGetValue("paths", out pv) && pv is List<object>) foreach (object o in (List<object>)pv) if (o != null) files.Add(o.ToString());
      if (files.Count == 0) throw new ArgumentException("no paths");
      var data = new DataObject();
      data.SetFileDropList(files);
      var eff = new System.IO.MemoryStream(BitConverter.GetBytes(B(d, "cut") ? 2 : 5)); // MOVE : COPY|LINK
      data.SetData("Preferred DropEffect", eff);
      Clipboard.SetDataObject(data, true, 5, 60);
      return "\"count\":" + files.Count;
    }
    static string ClipGet()
    {
      var sb = new StringBuilder("\"paths\":[");
      bool cut = false;
      if (Clipboard.ContainsFileDropList())
      {
        var l = Clipboard.GetFileDropList(); int n = 0;
        foreach (string s in l) { if (n++ > 0) sb.Append(','); sb.Append(Json.Q(s)); }
        try
        {
          var o = Clipboard.GetData("Preferred DropEffect") as System.IO.MemoryStream;
          if (o != null) { var b = new byte[4]; o.Read(b, 0, 4); cut = (BitConverter.ToInt32(b, 0) & 2) != 0; }
        }
        catch { }
      }
      sb.Append("],\"cut\":").Append(cut ? "true" : "false");
      return sb.ToString();
    }


    static string Items(bool selectedOnly)
    {
      IFolderView fv = DesktopFolderView();
      Guid ifs = IID_IShellFolder; IntPtr pf; Marshal.ThrowExceptionForHR(fv.GetFolder(ref ifs, out pf));
      var folder = (IShellFolder)Marshal.GetObjectForIUnknown(pf); Marshal.Release(pf);
      Guid ie = IID_IEnumIDList; IntPtr pe;
      var sb = new StringBuilder("\"items\":[");
      IntPtr lv = DesktopListView();
      if (fv.Items(selectedOnly ? 1u : 2u, ref ie, out pe) == 0 && pe != IntPtr.Zero)
      {
        var en = (IEnumIDList)Marshal.GetObjectForIUnknown(pe); Marshal.Release(pe);
        IntPtr pidl; uint got; bool first = true;
        while (en.Next(1, out pidl, out got) == 0 && got == 1)
        {
          try
          {
            STRRET sr; var buf = new StringBuilder(1024);
            if (folder.GetDisplayNameOf(pidl, 0x8000, out sr) != 0) continue;
            N.StrRetToBuf(ref sr, pidl, buf, buf.Capacity);
            string path = buf.ToString();
            if (path.StartsWith("::")) continue;
            POINT pt; if (fv.GetItemPosition(pidl, out pt) != 0) { pt.x = -1; pt.y = -1; }
            else if (lv != IntPtr.Zero) N.ClientToScreen(lv, ref pt);
            if (!first) sb.Append(','); first = false;
            sb.Append("{\"path\":").Append(Json.Q(path)).Append(",\"x\":").Append(pt.x).Append(",\"y\":").Append(pt.y).Append('}');
          }
          finally { N.CoTaskMemFree(pidl); }
        }
      }
      POINT sp = new POINT(); fv.GetSpacing(ref sp);
      sb.Append("],\"spacing\":{\"x\":").Append(sp.x).Append(",\"y\":").Append(sp.y).Append('}');
      return sb.ToString();
    }

    // ---------------------------------------------------------------- native Explorer context menu
    static string CtxMenu(Dictionary<string, object> d)
    {
      var paths = new List<string>();
      object pv; if (d.TryGetValue("paths", out pv) && pv is List<object>) foreach (object o in (List<object>)pv) if (o != null) paths.Add(o.ToString());
      if (paths.Count == 0) throw new ArgumentException("no paths");
      int x = (int)D(d, "x"), y = (int)D(d, "y");
      var extras = new List<Dictionary<string, object>>();
      object ev; if (d.TryGetValue("extras", out ev) && ev is List<object>) foreach (object o in (List<object>)ev) if (o is Dictionary<string, object>) extras.Add((Dictionary<string, object>)o);

      string dir0 = Path.GetDirectoryName(paths[0]) ?? "";
      IShellFolder parent = null; var children = new List<IntPtr>(); var abs = new List<IntPtr>(); bool partial = false;
      foreach (string p in paths)
      {
        if (!string.Equals(Path.GetDirectoryName(p) ?? "", dir0, StringComparison.OrdinalIgnoreCase)) { partial = true; continue; }
        IntPtr pidl; uint attrs;
        if (N.SHParseDisplayName(p, IntPtr.Zero, out pidl, 0, out attrs) != 0 || pidl == IntPtr.Zero) continue;
        abs.Add(pidl);
        Guid ifs = IID_IShellFolder; IntPtr ppf, last;
        if (N.SHBindToParent(pidl, ref ifs, out ppf, out last) != 0) continue;
        if (parent == null) parent = (IShellFolder)Marshal.GetObjectForIUnknown(ppf);
        Marshal.Release(ppf);
        children.Add(last);
      }
      if (parent == null || children.Count == 0) { foreach (IntPtr a in abs) N.CoTaskMemFree(a); throw new IOException("cannot resolve shell items"); }
      Guid icm = IID_IContextMenu; IntPtr pcm;
      int hr = parent.GetUIObjectOf(host.Handle, (uint)children.Count, children.ToArray(), ref icm, IntPtr.Zero, out pcm);
      if (hr != 0) { foreach (IntPtr a in abs) N.CoTaskMemFree(a); Marshal.ThrowExceptionForHR(hr); }
      object cmObj = Marshal.GetObjectForIUnknown(pcm); Marshal.Release(pcm);
      var cm = (IContextMenu)cmObj;
      host.cm2 = cmObj as IContextMenu2; host.cm3 = cmObj as IContextMenu3;
      IntPtr menu = N.CreatePopupMenu();
      string pick = "none", verb = null, extraId = null;
      try
      {
        bool shift = (N.GetKeyState(0x10) & 0x8000) != 0 || B(d, "shift");
        uint flags = 0x10 /*CANRENAME*/ | (shift ? 0x100u : 0u) /*EXTENDEDVERBS*/;
        cm.QueryContextMenu(menu, 0, 1, 0x7FFF, flags);
        // our items on top (Fences-style), then separator
        uint pos = 0;
        for (int i = 0; i < extras.Count; i++)
        {
          var e = extras[i];
          if (B(e, "sep")) { N.InsertMenu(menu, pos++, 0x400 | 0x800, UIntPtr.Zero, null); continue; }
          uint f = 0x400 | (B(e, "disabled") ? 0x1u : 0u);
          N.InsertMenu(menu, pos++, f, new UIntPtr((uint)(0x8000 + i)), S(e, "label") ?? "?");
        }
        if (extras.Count > 0) N.InsertMenu(menu, pos, 0x400 | 0x800, UIntPtr.Zero, null);
        N.SetForegroundWindow(host.Handle);
        int cmd = N.TrackPopupMenuEx(menu, 0x0100 /*RETURNCMD*/ | 0x0002 /*RIGHTBUTTON*/, x, y, host.Handle, IntPtr.Zero);
        N.PostMessage(host.Handle, 0, IntPtr.Zero, IntPtr.Zero);
        if (cmd >= 0x8000)
        {
          int idx = cmd - 0x8000; pick = "extra"; extraId = idx < extras.Count ? S(extras[idx], "id") : null;
        }
        else if (cmd > 0)
        {
          var vb = new StringBuilder(256);
          if (cm.GetCommandString(new UIntPtr((uint)(cmd - 1)), 4 /*GCS_VERBW*/, IntPtr.Zero, vb, vb.Capacity) == 0) verb = vb.ToString();
          if (verb == "rename") pick = "rename";
          else
          {
            var ici = new CMINVOKECOMMANDINFOEX();
            ici.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFOEX));
            ici.fMask = 0x4000 /*UNICODE*/ | 0x20000000 /*PTINVOKE*/;
            if ((N.GetKeyState(0x11) & 0x8000) != 0) ici.fMask |= 0x40000000; // CONTROL_DOWN
            if (shift) ici.fMask |= 0x10000000; // SHIFT_DOWN
            ici.hwnd = host.Handle; ici.lpVerb = new IntPtr(cmd - 1); ici.lpVerbW = new IntPtr(cmd - 1); ici.nShow = 1;
            ici.ptInvoke.x = x; ici.ptInvoke.y = y;
            Marshal.ThrowExceptionForHR(cm.InvokeCommand(ref ici));
            pick = "shell";
          }
        }
      }
      finally
      {
        host.cm2 = null; host.cm3 = null;
        N.DestroyMenu(menu);
        foreach (IntPtr a in abs) N.CoTaskMemFree(a);
      }
      return "\"pick\":" + Json.Q(pick) + ",\"verb\":" + Json.Q(verb) + ",\"extra\":" + Json.Q(extraId) + ",\"partial\":" + (partial ? "true" : "false");
    }

    // ---------------------------------------------------------------- low-level mouse hook
    static IntPtr hook = IntPtr.Zero; static N.HookProc hookProc; static uint hookTid = 0;
    static volatile bool dblOn, ctxApp; static volatile string drawBtn = "off";
    static uint lastTime; static POINT lastPt;
    // rubber band state: 0 idle, 1 pending (button down swallowed), 2 drawing
    static int rbState = 0; static bool rbRight; static POINT rbStart; static uint rbLastEmit;

    static void StartHook()
    {
      if (hookTid != 0) return;
      var t = new Thread(delegate ()
      {
        try
        {
          hookTid = N.GetCurrentThreadId();
          hookProc = new N.HookProc(Hook);
          hook = N.SetWindowsHookEx(14, hookProc, N.GetModuleHandle(null), 0);
          if (hook == IntPtr.Zero) Emit("{\"ev\":\"hook-failed\"}");
          N.MSG m;
          while (N.GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
          N.UnhookWindowsHookEx(hook);
        }
        catch (Exception e) { Emit("{\"ev\":\"hook-failed\",\"error\":" + Json.Q(e.Message) + "}"); }
        hook = IntPtr.Zero; hookTid = 0;
      });
      t.IsBackground = true; t.Start();
    }
    static void StopHook() { if (hookTid != 0) N.PostThreadMessage(hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); }

    static bool IsDesktopSurface(IntPtr win, out IntPtr lv)
    {
      lv = IntPtr.Zero;
      string wc = N.Cls(win);
      if (wc == "SysListView32" && N.Cls(N.GetParent(win)) == "SHELLDLL_DefView") { lv = win; return true; }
      if (wc == "SHELLDLL_DefView" || wc == "WorkerW" || wc == "Progman") return true;
      return false;
    }

    // Cross-process LVM_HITTEST into explorer (reused buffer); falls back to hot item.
    static IntPtr hitLv = IntPtr.Zero, hitProc = IntPtr.Zero, hitMem = IntPtr.Zero;
    static int HitItem(IntPtr lv, POINT screenPt)
    {
      try
      {
        if (lv != hitLv)
        {
          if (hitProc != IntPtr.Zero) N.CloseHandle(hitProc);
          hitProc = IntPtr.Zero; hitMem = IntPtr.Zero; hitLv = lv;
          uint pid; N.GetWindowThreadProcessId(lv, out pid);
          hitProc = N.OpenProcess(0x0008 | 0x0010 | 0x0020, false, pid);
          if (hitProc != IntPtr.Zero) hitMem = N.VirtualAllocEx(hitProc, IntPtr.Zero, new UIntPtr(64), 0x3000, 0x04);
        }
        POINT c = screenPt; N.ScreenToClient(lv, ref c);
        IntPtr r;
        if (hitProc != IntPtr.Zero && hitMem != IntPtr.Zero)
        {
          var buf = new byte[24];
          BitConverter.GetBytes(c.x).CopyTo(buf, 0); BitConverter.GetBytes(c.y).CopyTo(buf, 4);
          UIntPtr n;
          if (N.WriteProcessMemory(hitProc, hitMem, buf, new UIntPtr(24), out n))
          {
            if (N.SendMessageTimeout(lv, 0x1012 /*LVM_HITTEST*/, IntPtr.Zero, hitMem, 2, 60, out r) != IntPtr.Zero) return (int)r.ToInt64();
          }
        }
        if (N.SendMessageTimeout(lv, 0x103D /*LVM_GETHOTITEM*/, IntPtr.Zero, IntPtr.Zero, 2, 40, out r) != IntPtr.Zero) return (int)r.ToInt64();
      }
      catch { }
      return -1;
    }

    static bool EmptyDesktopAt(POINT pt)
    {
      IntPtr lv; IntPtr win = N.WindowFromPoint(pt);
      if (!IsDesktopSurface(win, out lv)) return false;
      if (lv == IntPtr.Zero || !N.IsWindowVisible(lv)) return true; // icons hidden: whole desktop is empty space
      return HitItem(lv, pt) < 0;
    }

    static void Replay(bool right, int x, int y)
    {
      ThreadPool.QueueUserWorkItem(delegate (object o)
      {
        Thread.Sleep(15);
        var inp = new N.INPUT[2];
        inp[0].type = 0; inp[0].mi.flags = right ? 0x0008u : 0x0002u; inp[0].mi.extra = MAGIC;
        inp[1].type = 0; inp[1].mi.flags = right ? 0x0010u : 0x0004u; inp[1].mi.extra = MAGIC;
        N.SendInput(2, inp, Marshal.SizeOf(typeof(N.INPUT)));
      });
    }

    static string Pt(POINT p) { return "\"x\":" + p.x + ",\"y\":" + p.y; }

    static IntPtr Hook(int code, IntPtr w, IntPtr l)
    {
      if (code < 0) return N.CallNextHookEx(hook, code, w, l);
      int msg = (int)w.ToInt64();
      N.MSLL dt = (N.MSLL)Marshal.PtrToStructure(l, typeof(N.MSLL));
      if (dt.extra == MAGIC) return N.CallNextHookEx(hook, code, w, l); // our replayed click
      bool drawRight = drawBtn == "right", drawLeft = drawBtn == "left";
      try
      {
        if (msg == 0x0201) // LBUTTONDOWN
        {
          if (dblOn)
          {
            bool dbl = (dt.time - lastTime) <= N.GetDoubleClickTime() && Math.Abs(dt.pt.x - lastPt.x) < 6 && Math.Abs(dt.pt.y - lastPt.y) < 6;
            lastTime = dt.time; lastPt = dt.pt;
            if (dbl) { lastTime = 0; if (EmptyDesktopAt(dt.pt)) Emit("{\"ev\":\"dblclick-desktop\"}"); }
          }
          if (drawLeft && rbState == 0 && EmptyDesktopAt(dt.pt)) { rbState = 1; rbRight = false; rbStart = dt.pt; return new IntPtr(1); }
        }
        else if (msg == 0x0204) // RBUTTONDOWN
        {
          if ((drawRight || ctxApp) && rbState == 0 && EmptyDesktopAt(dt.pt)) { rbState = 1; rbRight = true; rbStart = dt.pt; return new IntPtr(1); }
        }
        else if (msg == 0x0200) // MOUSEMOVE
        {
          if (rbState == 1 && ((rbRight && drawRight) || (!rbRight && drawLeft)) && (Math.Abs(dt.pt.x - rbStart.x) > 6 || Math.Abs(dt.pt.y - rbStart.y) > 6))
          {
            rbState = 2; rbLastEmit = dt.time;
            Emit("{\"ev\":\"rb-start\"," + Pt(rbStart) + ",\"btn\":" + Json.Q(rbRight ? "right" : "left") + "}");
          }
          if (rbState == 2 && dt.time - rbLastEmit >= 15) { rbLastEmit = dt.time; Emit("{\"ev\":\"rb-move\"," + Pt(dt.pt) + "}"); }
        }
        else if ((msg == 0x0205 && rbState != 0 && rbRight) || (msg == 0x0202 && rbState != 0 && !rbRight)) // button up
        {
          int st = rbState; rbState = 0;
          if (st == 2)
          {
            Emit("{\"ev\":\"rb-end\",\"x1\":" + rbStart.x + ",\"y1\":" + rbStart.y + ",\"x2\":" + dt.pt.x + ",\"y2\":" + dt.pt.y + ",\"btn\":" + Json.Q(rbRight ? "right" : "left") + "}");
          }
          else if (rbRight && ctxApp) Emit("{\"ev\":\"context-desktop\"," + Pt(dt.pt) + "}");
          else Replay(rbRight, dt.pt.x, dt.pt.y);
          return new IntPtr(1);
        }
      }
      catch { }
      return N.CallNextHookEx(hook, code, w, l);
    }
  }
}
