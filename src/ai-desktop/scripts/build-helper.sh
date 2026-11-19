#!/usr/bin/env bash
# Rebuild the native Windows helper (C# 5 / .NET Framework 4.x, no extra deps).
# On Linux: needs mono-mcs. On Windows: csc.exe from %WINDIR%\Microsoft.NET\Framework64\v4.0.30319 works with the same flags.
set -euo pipefail
cd "$(dirname "$0")/../native"
mcs -langversion:5 -platform:x64 -target:winexe -optimize+ -out:AIDeskHelper.exe \
  -r:System.Windows.Forms.dll -r:System.Drawing.dll AIDeskHelper.cs
ls -l AIDeskHelper.exe
