// Windows only: looks at what the sound system does with the voice, from outside the browser.
// Nothing is installed: Windows PowerShell compiles this file on the spot.
//
//   Add-Type -TypeDefinition (Get-Content -Raw carbowl\tools\exp\wasapi.cs)
//   [CarbowlLab.Wasapi]::Info()                                  default devices, formats, declared effects
//   [CarbowlLab.Wasapi]::Sessions()                              which programs hold a sound stream right now
//   [CarbowlLab.Wasapi]::Record('out.wav', 20, 'none')           what Windows sends to the speakers, 20 s
//   [CarbowlLab.Wasapi]::Record('out.wav', 20, 'comm')           the same while a call-style microphone stream is open
//
// Record() captures the "loopback" of the default output device: the mix after Windows' own
// software effects, before the hardware. The third argument also opens the default microphone
// (its sound is thrown away) the way a program might: 'other' (plain), 'comm' (as a call does),
// 'raw' (asking for no processing), 'speech'. 'none' leaves the microphone alone.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CarbowlLab {

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorClass { }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct PropertyKey { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Explicit)]
  internal struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct AudioClientProperties { public uint cbSize; public int bIsOffload; public int eCategory; public int Options; }

  // IAudioClient's twelve methods, then IAudioClient2's three.
  [ComImport, Guid("726778CD-F60A-4eda-82DE-E47610CD78AA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioClient2 {
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    [PreserveSig] int IsOffloadCapable(int category, out int offloadCapable);
    [PreserveSig] int SetClientProperties(ref AudioClientProperties props);
    [PreserveSig] int GetBufferSizeLimits(IntPtr format, int eventDriven, out long min, out long max);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }

  [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioRenderClient {
    [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
    [PreserveSig] int ReleaseBuffer(uint frames, uint flags);
  }

  [ComImport, Guid("4460B3AE-4B44-4527-8676-7548A8ACD260"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEffectsManager {
    [PreserveSig] int RegisterAudioEffectsChangedNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterAudioEffectsChangedNotificationCallback(IntPtr client);
    [PreserveSig] int GetAudioEffects(out IntPtr effects, out uint count);
    [PreserveSig] int SetAudioEffectState(Guid effectId, int state);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  // IAudioSessionControl's nine methods, then IAudioSessionControl2's five.
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(int optOut);
  }

  internal class Fmt {
    public int tag, channels, rate, bits, blockAlign, validBits; public bool isFloat;
    public override string ToString () { return rate + " Hz, " + channels + " ch, " + bits + "-bit " + (isFloat ? "float" : "integer"); }
  }

  public static class Wasapi {
    const int CLSCTX_ALL = 23;
    const uint LOOPBACK = 0x00020000;
    static readonly Guid IID_IAudioClient2 = new Guid("726778CD-F60A-4eda-82DE-E47610CD78AA");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static readonly Guid IID_IAudioEffectsManager = new Guid("4460B3AE-4B44-4527-8676-7548A8ACD260");
    static readonly Guid SUB_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");

    static void Check (int hr, string what) { if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }

    static IMMDevice DefaultDevice (int flow, int role) {
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorClass());
      IMMDevice dev; Check(en.GetDefaultAudioEndpoint(flow, role, out dev), "GetDefaultAudioEndpoint");
      return dev;
    }

    /** The output whose name contains `name` (say "Speakers"), or the default output when `name` is empty. */
    static IMMDevice Output (string name) {
      if (name == null || name == "") return DefaultDevice(0, 0);
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorClass());
      IMMDeviceCollection all; Check(en.EnumAudioEndpoints(0, 1, out all), "EnumAudioEndpoints");
      uint n; all.GetCount(out n);
      for (uint i = 0; i < n; i++) { IMMDevice d; if (all.Item(i, out d) == 0 && NameOf(d).IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) return d; }
      throw new Exception("no active output is called '" + name + "'");
    }

    public static string InfoFor (string name) {
      StringBuilder sb = new StringBuilder();
      IMMDevice spk = Output(name);
      sb.AppendLine("Output: " + NameOf(spk));
      int[] rcat = { 0, 3 };
      foreach (int c in rcat) sb.AppendLine("  played as " + CATEGORY[c] + ": " + Effects(spk, c, 0));
      return sb.ToString();
    }

    public static string PlayRecordOn (string output, string programPath, string outPath, string mic, string playAs) {
      chosen = output; try { return PlayRecord(programPath, outPath, mic, playAs); } finally { chosen = ""; }
    }
    static string chosen = "";

    static string NameOf (IMMDevice dev) {
      try {
        IPropertyStore ps; if (dev.OpenPropertyStore(0, out ps) != 0) return "?";
        PropertyKey k = new PropertyKey(); k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;
        PropVariant v; if (ps.GetValue(ref k, out v) != 0) return "?";
        return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "?";
      } catch (Exception) { return "?"; }
    }

    static IAudioClient2 Client (IMMDevice dev) {
      Guid iid = IID_IAudioClient2; object o; Check(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
      return (IAudioClient2)o;
    }

    static Fmt ReadFormat (IntPtr p) {
      Fmt f = new Fmt();
      f.tag = (ushort)Marshal.ReadInt16(p, 0); f.channels = Marshal.ReadInt16(p, 2); f.rate = Marshal.ReadInt32(p, 4);
      f.blockAlign = Marshal.ReadInt16(p, 12); f.bits = Marshal.ReadInt16(p, 14);
      int cb = Marshal.ReadInt16(p, 16);
      f.isFloat = f.tag == 3; f.validBits = f.bits;
      if (f.tag == 0xFFFE && cb >= 22) {
        f.validBits = Marshal.ReadInt16(p, 18);
        byte[] g = new byte[16]; Marshal.Copy(new IntPtr(p.ToInt64() + 24), g, 0, 16);
        f.isFloat = new Guid(g) == SUB_FLOAT;
      }
      return f;
    }

    static readonly string[] CATEGORY = { "other", "foreground media", "background media", "communications", "alerts", "sound effects", "game effects", "game media", "game chat", "speech", "movie", "media" };

    static string EffectName (Guid g) {
      string s = g.ToString().ToLowerInvariant();
      string[] names = { "echo cancellation", "noise suppression", "automatic gain control", "beamforming", "constant tone removal", "equalizer", "loudness equalizer", "bass boost", "virtual surround", "virtual headphones", "speaker fill", "room correction", "bass management", "environmental effects", "speaker protection", "speaker compensation", "dynamic range compression", "far-field beamforming" };
      if (s.StartsWith("6f64ad") && s.EndsWith("-8211-11e2-8c70-2c27d7f001fa")) {
        int n = Convert.ToInt32(s.Substring(6, 2), 16) - 0xbe;
        if (n >= 0 && n < names.Length) return names[n];
      }
      if (s.StartsWith("6bb2aa1d")) return "deep noise suppression";
      return "effect " + s;
    }

    /** The effects Windows says it applies to a stream opened on this device in this way. */
    static string Effects (IMMDevice dev, int category, int options) {
      try {
        IAudioClient2 c = Client(dev);
        AudioClientProperties p = new AudioClientProperties(); p.cbSize = 16; p.bIsOffload = 0; p.eCategory = category; p.Options = options;
        int hr = c.SetClientProperties(ref p); if (hr != 0) return "cannot be opened this way (0x" + hr.ToString("X8") + ")";
        IntPtr fmt; Check(c.GetMixFormat(out fmt), "GetMixFormat");
        Fmt f = ReadFormat(fmt);
        hr = c.Initialize(0, 0, 2000000, 0, fmt, IntPtr.Zero); if (hr != 0) return "cannot be started this way (0x" + hr.ToString("X8") + ")";
        Guid iid = IID_IAudioEffectsManager; object o; hr = c.GetService(ref iid, out o);
        if (hr != 0) return f + "; effects not reported (0x" + hr.ToString("X8") + ")";
        IAudioEffectsManager m = (IAudioEffectsManager)o; IntPtr arr; uint n; hr = m.GetAudioEffects(out arr, out n);
        if (hr != 0) return f + "; effects not reported (0x" + hr.ToString("X8") + ")";
        List<string> list = new List<string>();
        for (int i = 0; i < n; i++) {
          IntPtr at = new IntPtr(arr.ToInt64() + i * 24);
          Guid id = (Guid)Marshal.PtrToStructure(at, typeof(Guid));
          int can = Marshal.ReadInt32(at, 16); int state = Marshal.ReadInt32(at, 20);
          list.Add(EffectName(id) + (state == 1 ? " ON" : " off") + (can != 0 ? " (switchable)" : ""));
        }
        if (arr != IntPtr.Zero) Marshal.FreeCoTaskMem(arr);
        return f + "; " + (list.Count > 0 ? string.Join(", ", list.ToArray()) : "no effects declared");
      } catch (Exception e) { return "error: " + e.Message; }
    }

    public static string Info () {
      StringBuilder sb = new StringBuilder();
      IMMDevice spk = DefaultDevice(0, 0); IMMDevice mic = DefaultDevice(1, 0);
      sb.AppendLine("Output: " + NameOf(spk));
      int[] rcat = { 0, 11, 3, 9 };
      foreach (int c in rcat) sb.AppendLine("  played as " + CATEGORY[c] + ": " + Effects(spk, c, 0));
      sb.AppendLine("  played as other, asking for no processing: " + Effects(spk, 0, 1));
      sb.AppendLine("Microphone: " + NameOf(mic));
      int[] ccat = { 0, 3, 9 };
      foreach (int c in ccat) sb.AppendLine("  opened as " + CATEGORY[c] + ": " + Effects(mic, c, 0));
      sb.AppendLine("  opened as other, asking for no processing: " + Effects(mic, 0, 1));
      sb.AppendLine("  opened as communications, asking for no processing: " + Effects(mic, 3, 1));
      return sb.ToString();
    }

    public static string Sessions () {
      StringBuilder sb = new StringBuilder();
      string[] states = { "idle", "ACTIVE", "ended" };
      for (int flow = 0; flow < 2; flow++) {
        IMMDevice d = DefaultDevice(flow, 0);
        sb.AppendLine((flow == 0 ? "Output: " : "Microphone: ") + NameOf(d));
        Guid iid = IID_IAudioSessionManager2; object o; Check(d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate sessions");
        IAudioSessionEnumerator en; Check(((IAudioSessionManager2)o).GetSessionEnumerator(out en), "GetSessionEnumerator");
        int n; en.GetCount(out n);
        for (int i = 0; i < n; i++) {
          IAudioSessionControl2 s; if (en.GetSession(i, out s) != 0 || s == null) continue;
          int st; s.GetState(out st); uint pid; s.GetProcessId(out pid);
          string name = "?"; try { name = pid == 0 ? "system sounds" : Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { name = "(gone)"; }
          sb.AppendLine("  " + (st >= 0 && st < 3 ? states[st] : "?") + "  " + name + " (" + pid + ")");
        }
      }
      return sb.ToString();
    }

    static void WriteHeader (Stream s, Fmt f, long dataBytes) {
      BinaryWriter w = new BinaryWriter(s);
      s.Seek(0, SeekOrigin.Begin);
      w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write((uint)(36 + dataBytes)); w.Write(Encoding.ASCII.GetBytes("WAVE"));
      w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write((uint)16); w.Write((ushort)3); w.Write((ushort)f.channels); w.Write((uint)f.rate);
      w.Write((uint)(f.rate * f.channels * 4)); w.Write((ushort)(f.channels * 4)); w.Write((ushort)32);
      w.Write(Encoding.ASCII.GetBytes("data")); w.Write((uint)dataBytes); w.Flush();
    }

    /** Copies one packet into 32-bit floats. */
    static byte[] ToFloat (IntPtr data, int frames, Fmt f, bool silent) {
      int n = frames * f.channels; byte[] outb = new byte[n * 4];
      if (silent || data == IntPtr.Zero) return outb;
      if (f.isFloat && f.bits == 32) { Marshal.Copy(data, outb, 0, n * 4); return outb; }
      float[] fl = new float[n];
      if (!f.isFloat && f.bits == 16) { short[] sh = new short[n]; Marshal.Copy(data, sh, 0, n); for (int i = 0; i < n; i++) fl[i] = sh[i] / 32768f; }
      else if (!f.isFloat && f.bits == 32) { int[] it = new int[n]; Marshal.Copy(data, it, 0, n); for (int i = 0; i < n; i++) fl[i] = it[i] / 2147483648f; }
      else if (!f.isFloat && f.bits == 24) { byte[] raw = new byte[n * 3]; Marshal.Copy(data, raw, 0, n * 3); for (int i = 0; i < n; i++) { int v = (raw[i * 3] | (raw[i * 3 + 1] << 8) | ((sbyte)raw[i * 3 + 2] << 16)); fl[i] = v / 8388608f; } }
      else throw new Exception("unsupported sample format: " + f);
      Buffer.BlockCopy(fl, 0, outb, 0, n * 4); return outb;
    }

    /**
     * Plays a prepared programme (mono 32-bit floats at the output's own rate) on the default output
     * the way an ordinary program would, and records what Windows makes of it. `playAs`: 'other'
     * (what a browser does), 'media', 'comm' (as a call), 'raw' (asking for no processing: the control).
     */
    public static string PlayRecord (string programPath, string outPath, string mic, string playAs) {
      StringBuilder sb = new StringBuilder();
      byte[] prog = File.ReadAllBytes(programPath); int total = prog.Length / 4;
      float[] mono = new float[total]; Buffer.BlockCopy(prog, 0, mono, 0, total * 4);
      IMMDevice spk = Output(chosen);

      IAudioClient2 rc = Client(spk);
      AudioClientProperties rp = new AudioClientProperties(); rp.cbSize = 16; rp.bIsOffload = 0;
      rp.eCategory = playAs == "comm" ? 3 : playAs == "media" ? 11 : 0; rp.Options = playAs == "raw" ? 1 : 0;
      Check(rc.SetClientProperties(ref rp), "SetClientProperties output");
      IntPtr rfp; Check(rc.GetMixFormat(out rfp), "GetMixFormat output"); Fmt rf = ReadFormat(rfp);
      if (!rf.isFloat || rf.bits != 32) throw new Exception("output format is not 32-bit float: " + rf);
      if (rf.rate != 48000) throw new Exception("the programme is made for 48000 Hz, the output runs at " + rf.rate);
      Check(rc.Initialize(0, 0, 2000000, 0, rfp, IntPtr.Zero), "Initialize output");
      uint bufFrames; Check(rc.GetBufferSize(out bufFrames), "GetBufferSize");
      Guid rid = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"); object ro; Check(rc.GetService(ref rid, out ro), "GetService render");
      IAudioRenderClient ren = (IAudioRenderClient)ro;

      IAudioClient2 lc = Client(spk);
      IntPtr lf; Check(lc.GetMixFormat(out lf), "GetMixFormat"); Fmt f = ReadFormat(lf);
      Check(lc.Initialize(0, LOOPBACK, 2000000, 0, lf, IntPtr.Zero), "Initialize loopback");
      Guid capIid = IID_IAudioCaptureClient; object o; Check(lc.GetService(ref capIid, out o), "GetService capture");
      IAudioCaptureClient lcap = (IAudioCaptureClient)o;
      sb.AppendLine("output: " + NameOf(spk) + ", " + f + "; played as '" + playAs + "'");

      IAudioClient2 mc = null; IAudioCaptureClient mcap = null; Fmt mf = null; long micFrames = 0;
      if (mic != null && mic != "" && mic != "none") {
        IMMDevice md = DefaultDevice(1, mic == "comm" ? 2 : 0);
        mc = Client(md);
        AudioClientProperties p = new AudioClientProperties(); p.cbSize = 16; p.bIsOffload = 0;
        p.eCategory = mic == "comm" ? 3 : mic == "speech" ? 9 : 0; p.Options = mic == "raw" ? 1 : 0;
        Check(mc.SetClientProperties(ref p), "SetClientProperties microphone");
        IntPtr mfp; Check(mc.GetMixFormat(out mfp), "GetMixFormat microphone"); mf = ReadFormat(mfp);
        Check(mc.Initialize(0, 0, 2000000, 0, mfp, IntPtr.Zero), "Initialize microphone");
        object mo; Check(mc.GetService(ref capIid, out mo), "GetService microphone"); mcap = (IAudioCaptureClient)mo;
        sb.AppendLine("microphone open as '" + mic + "': " + NameOf(md) + ", " + mf);
      }

      long frames = 0, gaps = 0, breaks = 0; double peak = 0; double expected = -1; int pos = 0; long underruns = 0;
      using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.ReadWrite)) {
        WriteHeader(fs, f, 0);
        fs.Seek(44, SeekOrigin.Begin);
        if (mc != null) Check(mc.Start(), "Start microphone");
        Check(lc.Start(), "Start loopback");
        bool started = false; double endAt = -1;
        Stopwatch sw = Stopwatch.StartNew();
        while (endAt < 0 || sw.Elapsed.TotalSeconds < endAt) {
          if (pos < total) {
            uint pad; rc.GetCurrentPadding(out pad);
            if (started && pad == 0) underruns++;
            int n = Math.Min((int)(bufFrames - pad), total - pos);
            if (n > 0) {
              IntPtr d; Check(ren.GetBuffer((uint)n, out d), "GetBuffer output");
              float[] inter = new float[n * rf.channels];
              for (int i = 0; i < n; i++) { float v = mono[pos + i]; inter[i * rf.channels] = v; if (rf.channels > 1) inter[i * rf.channels + 1] = v; }
              Marshal.Copy(inter, 0, d, inter.Length);
              Check(ren.ReleaseBuffer((uint)n, 0), "ReleaseBuffer output"); pos += n;
            }
            if (!started) { Check(rc.Start(), "Start output"); started = true; }
            if (pos >= total) endAt = sw.Elapsed.TotalSeconds + 0.2 + 1.0; // what is still queued, and a second of tail
          }
          uint next; lcap.GetNextPacketSize(out next);
          while (next > 0) {
            IntPtr data; uint got; uint flags; ulong dpos; ulong qpc;
            Check(lcap.GetBuffer(out data, out got, out flags, out dpos, out qpc), "GetBuffer");
            if ((flags & 1) != 0 && frames > 0) breaks++;
            if (expected >= 0) {
              double late = (double)qpc - expected;
              if (late > 30000) { long miss = (long)Math.Round(late * f.rate / 1e7); if (miss > 0) { fs.Write(new byte[miss * f.channels * 4], 0, (int)(miss * f.channels * 4)); frames += miss; gaps++; } }
            }
            byte[] b = ToFloat(data, (int)got, f, (flags & 2) != 0);
            for (int i = 0; i < b.Length; i += 4) { double v = Math.Abs(BitConverter.ToSingle(b, i)); if (v > peak) peak = v; }
            fs.Write(b, 0, b.Length); frames += got;
            expected = (double)qpc + (double)got * 1e7 / f.rate;
            lcap.ReleaseBuffer(got);
            lcap.GetNextPacketSize(out next);
          }
          if (mcap != null) {
            uint mn; mcap.GetNextPacketSize(out mn);
            while (mn > 0) {
              IntPtr data; uint got; uint flags; ulong dpos; ulong qpc;
              if (mcap.GetBuffer(out data, out got, out flags, out dpos, out qpc) != 0) break;
              micFrames += got; mcap.ReleaseBuffer(got); mcap.GetNextPacketSize(out mn);
            }
          }
          Thread.Sleep(4);
        }
        rc.Stop(); lc.Stop(); if (mc != null) mc.Stop();
        WriteHeader(fs, f, frames * f.channels * 4);
      }
      sb.AppendLine("played " + (total / 48000.0).ToString("F2") + " s, recorded " + (frames / (double)f.rate).ToString("F2") + " s, peak " + peak.ToString("F4") + ", quiet stretches written in " + gaps + ", stream breaks flagged " + breaks + ", times the output ran dry " + underruns);
      if (mc != null) sb.AppendLine("microphone delivered " + (micFrames / (double)mf.rate).ToString("F2") + " s");
      return sb.ToString();
    }

    public static string Record (string outPath, double seconds, string mic) {
      StringBuilder sb = new StringBuilder();
      IMMDevice spk = DefaultDevice(0, 0);
      IAudioClient2 lc = Client(spk);
      IntPtr lf; Check(lc.GetMixFormat(out lf), "GetMixFormat");
      Fmt f = ReadFormat(lf);
      Check(lc.Initialize(0, LOOPBACK, 2000000, 0, lf, IntPtr.Zero), "Initialize loopback");
      Guid capIid = IID_IAudioCaptureClient; object o; Check(lc.GetService(ref capIid, out o), "GetService capture");
      IAudioCaptureClient lcap = (IAudioCaptureClient)o;
      sb.AppendLine("output: " + NameOf(spk) + ", " + f);

      IAudioClient2 mc = null; IAudioCaptureClient mcap = null; Fmt mf = null; double micPeak = 0; long micFrames = 0;
      if (mic != null && mic != "" && mic != "none") {
        IMMDevice md = DefaultDevice(1, mic == "comm" ? 2 : 0);
        mc = Client(md);
        AudioClientProperties p = new AudioClientProperties(); p.cbSize = 16; p.bIsOffload = 0;
        p.eCategory = mic == "comm" ? 3 : mic == "speech" ? 9 : 0; p.Options = mic == "raw" ? 1 : 0;
        Check(mc.SetClientProperties(ref p), "SetClientProperties microphone");
        IntPtr mfp; Check(mc.GetMixFormat(out mfp), "GetMixFormat microphone"); mf = ReadFormat(mfp);
        Check(mc.Initialize(0, 0, 2000000, 0, mfp, IntPtr.Zero), "Initialize microphone");
        object mo; Check(mc.GetService(ref capIid, out mo), "GetService microphone"); mcap = (IAudioCaptureClient)mo;
        sb.AppendLine("microphone open as '" + mic + "': " + NameOf(md) + ", " + mf);
      }

      long frames = 0, gaps = 0, gapFrames = 0, breaks = 0; double peak = 0; double expected = -1;
      using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.ReadWrite)) {
        WriteHeader(fs, f, 0);
        fs.Seek(44, SeekOrigin.Begin);
        if (mc != null) Check(mc.Start(), "Start microphone");
        Check(lc.Start(), "Start loopback");
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < seconds) {
          uint next; lcap.GetNextPacketSize(out next);
          while (next > 0) {
            IntPtr data; uint got; uint flags; ulong pos; ulong qpc;
            Check(lcap.GetBuffer(out data, out got, out flags, out pos, out qpc), "GetBuffer");
            if ((flags & 1) != 0 && frames > 0) breaks++;
            // Nothing arrives while nothing plays: keep the time line whole by writing the silence in.
            if (expected >= 0) {
              double late = (double)qpc - expected;
              if (late > 30000) { long miss = (long)Math.Round(late * f.rate / 1e7); if (miss > 0) { fs.Write(new byte[miss * f.channels * 4], 0, (int)(miss * f.channels * 4)); frames += miss; gaps++; gapFrames += miss; } }
            }
            byte[] b = ToFloat(data, (int)got, f, (flags & 2) != 0);
            for (int i = 0; i < b.Length; i += 4) { double v = Math.Abs(BitConverter.ToSingle(b, i)); if (v > peak) peak = v; }
            fs.Write(b, 0, b.Length); frames += got;
            expected = (double)qpc + (double)got * 1e7 / f.rate;
            lcap.ReleaseBuffer(got);
            lcap.GetNextPacketSize(out next);
          }
          if (mcap != null) {
            uint mn; mcap.GetNextPacketSize(out mn);
            while (mn > 0) {
              IntPtr data; uint got; uint flags; ulong pos; ulong qpc;
              if (mcap.GetBuffer(out data, out got, out flags, out pos, out qpc) != 0) break;
              if ((flags & 2) == 0 && mf.isFloat && mf.bits == 32 && got > 0) { float[] t = new float[got * mf.channels]; Marshal.Copy(data, t, 0, t.Length); for (int i = 0; i < t.Length; i++) { double v = Math.Abs(t[i]); if (v > micPeak) micPeak = v; } }
              micFrames += got; mcap.ReleaseBuffer(got); mcap.GetNextPacketSize(out mn);
            }
          }
          Thread.Sleep(4);
        }
        lc.Stop(); if (mc != null) mc.Stop();
        long bytes = frames * f.channels * 4;
        WriteHeader(fs, f, bytes);
      }
      sb.AppendLine("recorded " + (frames / (double)f.rate).ToString("F2") + " s (" + frames + " frames), peak " + peak.ToString("F4") + ", silence written in for " + gaps + " quiet stretches (" + (gapFrames / (double)f.rate).ToString("F2") + " s), stream breaks flagged " + breaks);
      if (mc != null) sb.AppendLine("microphone delivered " + (micFrames / (double)mf.rate).ToString("F2") + " s, peak " + micPeak.ToString("F4"));
      return sb.ToString();
    }
  }
}
