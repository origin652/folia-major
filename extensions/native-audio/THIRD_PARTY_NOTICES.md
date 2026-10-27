# Third-party runtime

This mod's JS source is AGPL-3.0, consistent with Folia. The local development package includes an unmodified mpv Windows build containing FFmpeg and SoXR. It does not contain foobar2000 core/SDK code, HQPlayer code, or any claimed proprietary filter implementation.

The exact archive URL, SHA-256, mpv/FFmpeg revisions and upstream build-recipe release are pinned in `runtime.lock.json`. The packager preserves upstream documentation, includes the GPL-3.0 and LGPL-2.1 texts from that FFmpeg revision (hash-verified), includes Folia's AGPL license for the mod source, and records SHA-256 for each bundled runtime file. Installer/updater scripts and unrelated executables are excluded. Verify the archive before executing it. Custom engine paths are explicitly user-controlled and are not verified by this package.

- mpv: https://github.com/mpv-player/mpv (GPL-2.0-or-later by default; build configuration can affect licensing).
- Windows build and dependency recipes: https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261021
- FFmpeg: https://ffmpeg.org/legal.html (GPL-enabled builds carry the corresponding GPL obligations).
- SoXR: https://sourceforge.net/projects/soxr/ (LGPL-2.1-or-later).

The generated ZIP is a local development artifact, not an official Folium-signed release. Before public binary redistribution, provide equivalent access to the complete corresponding source of the exact engine build, including build scripts, patches and enabled dependencies, and retain the applicable license texts. Links to a project homepage alone are not a substitute for corresponding source. The pinned upstream build recipes identify the dependency revisions; they must be preserved and verified for a public release. No upload, signing or public distribution is performed by the packager.
