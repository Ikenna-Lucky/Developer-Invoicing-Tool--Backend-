# Alpine image security review

Historical investigation: the Alpine candidate and blocking image scan were
removed from CI on 24 November 2026 at the maintainer's request. The findings
below are retained as evidence; removal of the check did not remediate them.
The release status below describes the scan's security assessment, not a current
GitHub check. The backend continues to use the Debian Dockerfile.

Reviewed 24 November 2026. Release status: **blocked**. This review does not accept
risk, enable scanner exceptions, change the deployment image, or certify safety.

The source is the uploaded Grype report for commit
`957436763a127bf68ea1018767873cac470a0808`, image ID
`sha256:4bc535bf78a6fa12049303752222d1d5cc6d38f61cd94b27742e5a709220d980`.
It describes Alpine 3.24.4 and uses a valid database built 23 November 2026.
All 150 high/critical package matches are upstream `nvd:cpe` matches across
50 distinct CVEs. The architecture qualifiers identify x86_64. This review does
not transfer automatically to another architecture, package version, or image.

## Dispositions

All 50 official CVE records were retrieved from the CVE Program API and compared
with the report's affected versions and component descriptions. Eleven CVEs have
platform mismatches, covering 38 package matches. Six more concern components
absent from the resolved package set, covering 10 matches. The other 33 CVEs
cover 102 package matches and remain open pending package, build-option, or
reachability evidence. A source package match against several split libraries
is not proof that each library contains the vulnerable function.

The table is an initial advisory and architecture review. **Open** does not mean
confirmed exploitable, and **platform mismatch** or **component absent** does not install a suppression.
No finding is dismissed merely because this is a PDF workflow. Native libraries
loaded transitively by Chromium must also be considered.

The dependency resolver installs gst-plugins-base and gst-plugins-bad, but not
gst-plugins-good. Package archives for gstreamer 1.28.3-r0, gst-plugins-base
1.28.3-r0, cjson 1.7.19-r1 and sqlite-libs 3.53.4-r0 were downloaded with apk and
their file lists inspected. The base plugins include libgstopus.so: the Opus
finding stays open. The cJSON archive has libcjson.so but no libcjson_utils; the
SQLite library archive has no sqlite3 executable. These are package-level
observations, not a completed new-image scan or blanket reachability proof.

Alpine's SQLite build enables both FTS5 and session support. Its three non-CLI
findings therefore cannot be dismissed by assuming those extensions are disabled.
FFmpeg's stable build enables a broad codec/acceleration feature set; a PDF-only
HTTP API does not, by itself, prove every native decoder or encoder unreachable.

## Package availability and fixes

A disposable official Bun 1.4.5 Alpine container queried the stable Alpine 3.24
repositories. They currently offer the versions already present in the report:
OpenSSL 3.5.9-r1, GLib 2.88.4-r0, SQLite 3.53.4-r0, FFmpeg 8.1.3-r0,
ALSA 1.2.15.3-r0, cJSON 1.7.19-r1, GStreamer 1.28.3-r0, and CUPS 2.4.19-r1.
The upstream OpenSSL advisory schedules releases containing some fixes for
1 December 2026; a reference to 3.5.10 is not evidence that apk can install it now.

Alpine's chromium-headless-shell 158.0.8127.36-r0 still depends on FFmpeg, GLib,
GTK, ALSA and other flagged libraries. Switching to that package would not
remove those findings. Mixing edge packages into the stable image or deleting
shared libraries required by Chromium is not an implemented remediation.

Vendor sources checked:

- [Alpine main security records](https://secdb.alpinelinux.org/v3.24/main.json)
- [Alpine Chromium package](https://pkgs.alpinelinux.org/package/v3.24/community/x86_64/chromium)
- [Alpine FFmpeg build](https://github.com/alpinelinux/aports/blob/3.24-stable/community/ffmpeg/APKBUILD)
- [Alpine SQLite build](https://github.com/alpinelinux/aports/blob/3.24-stable/main/sqlite/APKBUILD)
- [Alpine cJSON build](https://github.com/alpinelinux/aports/blob/3.24-stable/main/cjson/APKBUILD)
- [OpenSSL advisory and release schedule](https://openssl-library.org/news/secadv/20261117.txt)
- [GStreamer MRF advisories](https://gstreamer.freedesktop.org/security/sa-2026-0050.html)
- [GStreamer RTP SBC advisory](https://gstreamer.freedesktop.org/security/sa-2026-0051.html)
- [GStreamer image-decoder advisory](https://gstreamer.freedesktop.org/security/sa-2026-0052.html)
- [GStreamer Opus advisory](https://gstreamer.freedesktop.org/security/sa-2026-0053.html)

## Verification limits and release decision

The Grype database archive referenced by the uploaded report was downloaded and
its SHA-256 verified as
`3d24f57cd3587e2c73f686decc7ad04b213d1f3575bcf1dd847e42df94560f14`
before import. A diagnostic SBOM reconstructed from the report's matched packages
did not reproduce the full match set; it is not a replacement for the image's
original inventory and is not clean-image evidence. No scanner correction was
enabled on the strength of that diagnostic.

An unchanged-recipe local image rebuild was stopped during dependency downloads;
the earlier hosted build/runtime/PDF results remain the available execution
evidence. No fresh full-image vulnerability scan is claimed. All 50 register rows
were checked for unique CVE coverage; formatting and diff checks passed. No
application behavior changed, so application tests were not rerun for this review.

The immediate release blockers are the 33 open CVEs below, not broken workflow
syntax. For each, a supported patched package, a verified backport, or enough
image-specific evidence to establish non-applicability is still needed. Any
temporary acceptance of an actual residual vulnerability needs a separate
release-owner decision with impact, mitigation, owner, deadline and expiry.
Nothing in this document supplies that acceptance. Keep both image jobs blocking
and do not promote the candidate based only on the lower finding count.

## CVE register

Each CVE link is its official CVE Program record, including upstream references.
The installed version is the representative matched package; the original report
contains all split-package matches. Scanner severity is retained in the report.

| CVE                                                                 | Package/version                | Disposition       | Evidence and next action                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CVE-2018-6553](https://www.cve.org/CVERecord?id=CVE-2018-6553)     | cups-libs 2.4.19-r1            | Platform mismatch | Ubuntu AppArmor profile; Alpine cups-libs is not that distribution component.                                                                                                                                                                                                                                                                          |
| [CVE-2026-107493](https://www.cve.org/CVERecord?id=CVE-2026-107493) | libcrypto3 3.5.9-r1            | Open              | Caller-supplied PEM stack; upstream fix targets OpenSSL 3.5.10. Stable apk offers 3.5.9-r1.                                                                                                                                                                                                                                                            |
| [CVE-2026-107494](https://www.cve.org/CVERecord?id=CVE-2026-107494) | libcrypto3 3.5.9-r1            | Open              | OpenSSL QUIC resource exhaustion; upstream fix targets 3.5.10. Stable apk offers 3.5.9-r1.                                                                                                                                                                                                                                                             |
| [CVE-2026-107696](https://www.cve.org/CVERecord?id=CVE-2026-107696) | ffmpeg-libswresample 8.1.3-r0  | Open              | FFmpeg through 9.0.2 contains an infinite loop vulnerability in ff_rtsp_connect() in libavformat/rtsp.c that follows RTSP 3xx redirects without any redirect limit. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                                |
| [CVE-2026-119373](https://www.cve.org/CVERecord?id=CVE-2026-119373) | sqlite-libs 3.53.4-r0          | Open              | FTS5 query on attacker-populated data; upstream fix 3.54.0; installed sqlite-libs 3.53.4-r0.                                                                                                                                                                                                                                                           |
| [CVE-2026-119374](https://www.cve.org/CVERecord?id=CVE-2026-119374) | sqlite-libs 3.53.4-r0          | Open              | FTS5 secure-delete on a crafted database; upstream fix 3.54.0; installed 3.53.4-r0.                                                                                                                                                                                                                                                                    |
| [CVE-2026-119379](https://www.cve.org/CVERecord?id=CVE-2026-119379) | sqlite-libs 3.53.4-r0          | Open              | SQLite session changesets; upstream fix 3.54.0; installed 3.53.4-r0; compile flags unverified.                                                                                                                                                                                                                                                         |
| [CVE-2026-119586](https://www.cve.org/CVERecord?id=CVE-2026-119586) | sqlite-libs 3.53.4-r0          | Component absent  | sqlite-libs contains only the shared library; the resolved dependency set does not install the sqlite3 CLI required by this advisory.                                                                                                                                                                                                                  |
| [CVE-2026-121482](https://www.cve.org/CVERecord?id=CVE-2026-121482) | libssl3 3.5.9-r1               | Open              | CMS/PKCS7 verification with CRL checking; fix targets 3.5.10; caller reachability unverified.                                                                                                                                                                                                                                                          |
| [CVE-2026-124709](https://www.cve.org/CVERecord?id=CVE-2026-124709) | libcrypto3 3.5.9-r1            | Open              | OpenSSL QUIC server stream retention; fix targets 3.5.10; caller reachability unverified.                                                                                                                                                                                                                                                              |
| [CVE-2026-125181](https://www.cve.org/CVERecord?id=CVE-2026-125181) | ffmpeg-libavcodec 8.1.3-r0     | Platform mismatch | Requires a big-endian build; x86_64 is little-endian.                                                                                                                                                                                                                                                                                                  |
| [CVE-2026-125196](https://www.cve.org/CVERecord?id=CVE-2026-125196) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in liboapve_encode() in libavcodec/liboapvenc.c that allows attackers to corrupt heap memory by supplying frames larger than the configured encoder dimensions. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition. |
| [CVE-2026-125202](https://www.cve.org/CVERecord?id=CVE-2026-125202) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in vaapi_hevc_start_frame() in libavcodec/vaapi_hevc.c that copies unbounded PPS tile counts into fixed-size arrays. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                            |
| [CVE-2026-125204](https://www.cve.org/CVERecord?id=CVE-2026-125204) | ffmpeg-libavutil 8.1.3-r0      | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow in ff_libwebp_get_frame() in libwebpenc_common.c that lets attackers corrupt memory when cr_threshold is set. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                                 |
| [CVE-2026-125208](https://www.cve.org/CVERecord?id=CVE-2026-125208) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains an out-of-bounds write vulnerability in v4l2_buffer_swframe_to_buf() in libavcodec/v4l2_buffers.c because cumulative plane offsets are not checked against the V4L2 buffer length. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                   |
| [CVE-2026-125210](https://www.cve.org/CVERecord?id=CVE-2026-125210) | ffmpeg-libswresample 8.1.3-r0  | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in aribcaption_trans_text_subtitle() in libavcodec/libaribcaption.c when decoding with sub_type text. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                           |
| [CVE-2026-125211](https://www.cve.org/CVERecord?id=CVE-2026-125211) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains an out-of-bounds read and invalid free vulnerability in aribcaption_trans_ass_subtitle() in libavcodec/libaribcaption.c that frees subtitle rectangles using region_count instead of num_rects. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.      |
| [CVE-2026-125212](https://www.cve.org/CVERecord?id=CVE-2026-125212) | ffmpeg-libavcodec 8.1.3-r0     | Platform mismatch | Requires Apple VideoToolbox; unavailable in this Linux build.                                                                                                                                                                                                                                                                                          |
| [CVE-2026-125213](https://www.cve.org/CVERecord?id=CVE-2026-125213) | ffmpeg-libavcodec 8.1.3-r0     | Platform mismatch | Requires a 32-bit allocation-size truncation; scanned build is 64-bit.                                                                                                                                                                                                                                                                                 |
| [CVE-2026-125214](https://www.cve.org/CVERecord?id=CVE-2026-125214) | ffmpeg-libavcodec 8.1.3-r0     | Platform mismatch | Requires a big-endian host; x86_64 is little-endian.                                                                                                                                                                                                                                                                                                   |
| [CVE-2026-125218](https://www.cve.org/CVERecord?id=CVE-2026-125218) | ffmpeg-libavutil 8.1.3-r0      | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in the APNG encoder's encode_apng() function in libavcodec/pngenc.c when frame size changes mid-stream. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                         |
| [CVE-2026-125219](https://www.cve.org/CVERecord?id=CVE-2026-125219) | ffmpeg-libswresample 8.1.3-r0  | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in vdpau_hevc_start_frame() in libavcodec/vdpau_hevc.c that copies unbounded PPS tile counts into fixed-size VDPAU arrays. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                      |
| [CVE-2026-125222](https://www.cve.org/CVERecord?id=CVE-2026-125222) | ffmpeg-libavcodec 8.1.3-r0     | Platform mismatch | Requires a 32-bit allocation-size overflow; scanned build is 64-bit.                                                                                                                                                                                                                                                                                   |
| [CVE-2026-125227](https://www.cve.org/CVERecord?id=CVE-2026-125227) | ffmpeg-libavutil 8.1.3-r0      | Platform mismatch | Requires a 32-bit build; scanned build is 64-bit.                                                                                                                                                                                                                                                                                                      |
| [CVE-2026-125229](https://www.cve.org/CVERecord?id=CVE-2026-125229) | ffmpeg-libavformat 8.1.3-r0    | Open              | FFmpeg through 9.0.2 contains an out-of-bounds memory access vulnerability in the encode_frame() function of libavcodec/huffyuvenc.c, because encode_init() never validates minimum frame dimensions for the median predictor. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.     |
| [CVE-2026-125233](https://www.cve.org/CVERecord?id=CVE-2026-125233) | ffmpeg-libavformat 8.1.3-r0    | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in dvbsub_encode() in libavcodec/dvbsubenc.c that undercounts each CLUT segment header by two bytes. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                            |
| [CVE-2026-125235](https://www.cve.org/CVERecord?id=CVE-2026-125235) | ffmpeg-libswresample 8.1.3-r0  | Open              | FFmpeg through 9.0.2 contains a heap overflow vulnerability in libavcodec/qsvenc.c that allows attackers to corrupt memory by reusing an undersized pooled QSVFrame buffer when input dimensions increase. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                         |
| [CVE-2026-125239](https://www.cve.org/CVERecord?id=CVE-2026-125239) | ffmpeg-libavformat 8.1.3-r0    | Platform mismatch | Requires Windows DXVA/D3D acceleration; unavailable in this Linux build.                                                                                                                                                                                                                                                                               |
| [CVE-2026-125241](https://www.cve.org/CVERecord?id=CVE-2026-125241) | ffmpeg-libswresample 8.1.3-r0  | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in libavcodec/flicvideo.c that allows attackers to write out of bounds because check_pixel_ptr() checks only one bound with negative-stride frames. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.             |
| [CVE-2026-125249](https://www.cve.org/CVERecord?id=CVE-2026-125249) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg 7.1 through 9.0.2 contains an integer overflow in ff_vk_decode_add_slice() in libavcodec/vulkan_decode.c that miscalculates the Vulkan hwaccel bitstream buffer size. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                       |
| [CVE-2026-125250](https://www.cve.org/CVERecord?id=CVE-2026-125250) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow in the GIF encoder's gif_image_write_image() in libavcodec/gif.c because shrunk_buf is sized from the first frame's linesize. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                 |
| [CVE-2026-125251](https://www.cve.org/CVERecord?id=CVE-2026-125251) | ffmpeg-libswresample 8.1.3-r0  | Platform mismatch | Requires a 32-bit build; scanned build is 64-bit.                                                                                                                                                                                                                                                                                                      |
| [CVE-2026-125256](https://www.cve.org/CVERecord?id=CVE-2026-125256) | ffmpeg-libavformat 8.1.3-r0    | Platform mismatch | Requires RISC-V vector instructions; scanned architecture is x86_64.                                                                                                                                                                                                                                                                                   |
| [CVE-2026-125257](https://www.cve.org/CVERecord?id=CVE-2026-125257) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains an off-by-one heap overflow vulnerability in get_exponent_dynamic() in libavcodec/nellymoserenc.c that allows writing one element past the opt and path allocations. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                 |
| [CVE-2026-125259](https://www.cve.org/CVERecord?id=CVE-2026-125259) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains an integer overflow vulnerability in ff_prores_kostya_encode_init() that miscalculates frame_size_upper_bound using 32-bit arithmetic for large frame dimensions. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                    |
| [CVE-2026-125260](https://www.cve.org/CVERecord?id=CVE-2026-125260) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in libavcodec/exrenc.c that allows attackers to corrupt heap memory when encode_scanline_rle() processes frames taller than the encoder height. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                 |
| [CVE-2026-125262](https://www.cve.org/CVERecord?id=CVE-2026-125262) | ffmpeg-libavcodec 8.1.3-r0     | Open              | FFmpeg through 9.0.2 contains a heap buffer overflow vulnerability in libavcodec/lcevcdec.c because LCEVC output picture dimensions are not validated against the allocated frame. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                                 |
| [CVE-2026-125269](https://www.cve.org/CVERecord?id=CVE-2026-125269) | ffmpeg-libavutil 8.1.3-r0      | Open              | FFmpeg through 9.0.2 contains a double free vulnerability in libavcodec/cbs_sei.c where cbs_sei_delete_message() leaves a stale extension_data reference that ff_cbs_sei_add_message() reuses. Upstream affected range includes the installed version; verify compiled feature and caller path before disposition.                                     |
| [CVE-2026-16554](https://www.cve.org/CVERecord?id=CVE-2026-16554)   | cjson 1.7.19-r1                | Platform mismatch | Requires 32-bit size_t; the scanned package is x86_64.                                                                                                                                                                                                                                                                                                 |
| [CVE-2026-18295](https://www.cve.org/CVERecord?id=CVE-2026-18295)   | gstreamer 1.28.3-r0            | Component absent  | Vendor identifies gst-plugins-good qtmoovrecover; the resolved Chromium package set does not install gst-plugins-good.                                                                                                                                                                                                                                 |
| [CVE-2026-18296](https://www.cve.org/CVERecord?id=CVE-2026-18296)   | gstreamer-ptp-helper 1.28.3-r0 | Component absent  | Vendor identifies gst-plugins-good qtmoovrecover; the resolved Chromium package set does not install gst-plugins-good.                                                                                                                                                                                                                                 |
| [CVE-2026-18297](https://www.cve.org/CVERecord?id=CVE-2026-18297)   | gstreamer-ptp-helper 1.28.3-r0 | Open              | GStreamer gst-plugins-base Opus decoder; fix 1.28.5; verify plugin presence and version.                                                                                                                                                                                                                                                               |
| [CVE-2026-18298](https://www.cve.org/CVERecord?id=CVE-2026-18298)   | gstreamer 1.28.3-r0            | Component absent  | Vendor identifies gst-plugins-good gdkpixbuf decoder; the resolved Chromium package set does not install gst-plugins-good.                                                                                                                                                                                                                             |
| [CVE-2026-18299](https://www.cve.org/CVERecord?id=CVE-2026-18299)   | gstreamer-ptp-helper 1.28.3-r0 | Component absent  | Vendor identifies gst-plugins-good RTP SBC plugin; the resolved Chromium package set does not install gst-plugins-good.                                                                                                                                                                                                                                |
| [CVE-2026-56109](https://www.cve.org/CVERecord?id=CVE-2026-56109)   | alsa-lib 1.2.15.3-r0           | Open              | ALSA configuration parser double-free; upstream fix 1.2.16.1; installed 1.2.15.3-r0.                                                                                                                                                                                                                                                                   |
| [CVE-2026-58016](https://www.cve.org/CVERecord?id=CVE-2026-58016)   | glib 2.88.4-r0                 | Open              | GLib D-Bus introspection XML; upstream affected range below 2.89.0; installed 2.88.4-r0.                                                                                                                                                                                                                                                               |
| [CVE-2026-67215](https://www.cve.org/CVERecord?id=CVE-2026-67215)   | cjson 1.7.19-r1                | Component absent  | The cjson package contains libcjson, without libcjson_utils; the affected JSON Patch utility component is absent.                                                                                                                                                                                                                                      |
| [CVE-2026-67216](https://www.cve.org/CVERecord?id=CVE-2026-67216)   | cjson 1.7.19-r1                | Open              | cJSON comparison complexity; installed 1.7.19-r1 falls in the affected upstream range.                                                                                                                                                                                                                                                                 |
| [CVE-2026-70632](https://www.cve.org/CVERecord?id=CVE-2026-70632)   | ffmpeg-libavformat 8.1.3-r0    | Open              | FFmpeg CFHD decoder affected from 4.4 to before 9.0; installed 8.1.3-r0 remains in range.                                                                                                                                                                                                                                                              |
| [CVE-2026-84786](https://www.cve.org/CVERecord?id=CVE-2026-84786)   | libcrypto3 3.5.9-r1            | Open              | OpenSSL DANE client validation; fix targets 3.5.10; caller reachability unverified.                                                                                                                                                                                                                                                                    |
