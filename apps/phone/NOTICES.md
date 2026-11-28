# Notices

## T3 Code

Two parts of this app follow T3 Code's mobile app (`apps/mobile`):

- The link module's interface to JavaScript (`modules/ttasks-link`) follows T3 Code's WebSocket
  module (`modules/t3-web-socket`): connections by number, the events `open`, `message`, `error`
  and `close`, each ending reported once, and 1006 for an ending without a close frame.
- The scanner (`src/App.tsx`, `Scanner`) follows its screen for adding a connection
  (`src/features/connection/ConnectionsNewRouteScreen.tsx`). It asks for the camera when the scan
  opens, offers the system settings once the camera was refused for good, takes the first code it
  can read, and keeps the camera open with a note after a code it cannot read.

The Android build (an Expo prebuild, then Gradle) follows it too. The code here is written for this
app: no file is copied. T3 Code is under this licence:

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
