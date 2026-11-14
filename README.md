<h1 align="center">Tacho for GNOME</h1>

<p align="center">
  <b>Gauges in the Ubuntu / GNOME top bar.</b><br>
  CPU and temperature, GPU, memory, network, your Claude Code and Codex limits, Docker containers and the Kubernetes context.
</p>

<p align="center">
  <a href="#english"><b>English</b></a> &nbsp;·&nbsp; <a href="#tiếng-việt">Tiếng Việt</a>
  &nbsp;·&nbsp; On a Mac? See <a href="https://github.com/hieupnvmg/Tacho">Tacho for macOS</a>
</p>

<!-- Screenshots: replace these placeholders with real captures from Ubuntu. -->
<p align="center">
  <img src="docs/images/combined.svg" alt="Combined layout: a column per reading with a faint graph behind it" width="100%">
</p>

---

## English

Tacho for GNOME is the Ubuntu counterpart of [Tacho for macOS](https://github.com/hieupnvmg/Tacho): the same readings and colours, as a GNOME Shell extension.

### What it shows

| Reading | In the top bar | In the menu |
|---|---|---|
| **CPU** | usage %, temperature (amber from 70 °C, red from 90 °C) | graph, temperature, load average |
| **GPU** | usage % and temperature of the busiest GPU | graph; each GPU's usage, frequency, video memory, temperature, power. A sleeping NVIDIA card on a hybrid laptop is shown as asleep, never woken |
| **Memory** | used % | graph, used / total, available, swap |
| **Network** | download and upload rate | graph, rates, VPN interfaces that are up |
| **AI** | the highest Claude Code or Codex limit window | 5-hour and 7-day bars with reset times, tokens today |
| **Docker** | running containers | engine status, every container with start/stop, memory per container and the engine total |
| **Kubernetes** | a wheel, **red when the context looks like production** (name or cluster contains `prod` or `prd`) | current context and namespace, a red PRODUCTION badge, other contexts |

Quick actions at the bottom of the menu: **Keep awake** (stops the screen blanking and the computer suspending), **Open System Monitor**, **Settings**.

Notifications: when a Claude Code or Codex limit passes **80 %** and **95 %** (once per window, again after it resets), and when a **VPN** interface comes up or goes down.

### Three layouts

Choose in Settings → Display:

| Combined | Separate, with graphs | Separate, without graphs |
|---|---|---|
| ![Combined](docs/images/combined.svg) | ![Separate with graphs](docs/images/separate-graphs.svg) | ![Separate](docs/images/separate.svg) |
| One item, a column per reading (small label on top, value below) with a faint history graph behind it. Click a column to open that reading's menu. | One item per reading, a small graph beside the value. | One item per reading, icon and value only. |

Each reading can be switched on or off, and CPU, memory and network update every 1, 2 or 5 seconds.

### Install

Requires GNOME Shell 45 or later (Ubuntu 23.10, 24.04 LTS, 24.10, 25.04 and later).

**From the latest release** (one line; includes pre-releases, add `-s -- --stable` to skip them):

```bash
curl -fsSL https://raw.githubusercontent.com/hieupnvmg/tacho-gnome/main/install.sh | bash
```

Or download `tacho@hieupnvmg.github.io.shell-extension.zip` from [Releases](https://github.com/hieupnvmg/tacho-gnome/releases) and run:

```bash
gnome-extensions install --force tacho@hieupnvmg.github.io.shell-extension.zip
```

Then **log out and back in** (on Wayland, the default on Ubuntu, GNOME Shell only picks up new extensions at login; on X11 you can press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, <kbd>Enter</kbd> instead), and enable it:

```bash
gnome-extensions enable tacho@hieupnvmg.github.io
```

Or use the **Extensions** app (`sudo apt install gnome-shell-extension-manager` gives you Extension Manager). Settings:

```bash
gnome-extensions prefs tacho@hieupnvmg.github.io
```

### Updates

Copies installed from GitHub releases update over the air: every 6 hours Tacho asks GitHub for a newer release, notifies you once, and puts **Update Tacho to …** in its menu. Choosing it downloads the zip, checks its SHA-256 and installs it; log out and back in to start the new version. Turn it off, or leave out pre-releases, in Settings → Updates. This check is the only time Tacho goes online.

The build for extensions.gnome.org has no updater; there, GNOME's Extensions app updates it.

### Build from source

```bash
sudo apt install make zip libglib2.0-bin gettext
```

```bash
git clone https://github.com/hieupnvmg/tacho-gnome.git && cd tacho-gnome && make install
```

`make` builds two zips: `build/github/` (updates itself from releases, what `make install` installs) and `build/ego/` (for extensions.gnome.org, no updater).

### Releasing

```bash
./release.sh 1.1.0 "What changed" --pre
```

Sets the version in `metadata.json`, runs the tests, builds both zips, commits, tags `v1.1.0`, pushes and creates the GitHub release with the zip and its `.sha256` (drop `--pre` for a normal release). Installed copies pick it up within 6 hours. Upload `build/ego/…zip` to [extensions.gnome.org](https://extensions.gnome.org/upload/) by hand.

### Claude Code limits

Codex writes its limits into its session logs, so they show up on their own. Claude Code does not: it only hands its 5-hour and 7-day limits to a **statusLine** command. This repository has a small one, [`tools/tacho-statusline`](tools/tacho-statusline) (bash and python3, both on Ubuntu by default). It writes the limits to `~/.claude/tacho-usage.json`, which Tacho reads, and prints a short status line in Claude Code.

```bash
install -Dm755 tools/tacho-statusline ~/.local/bin/tacho-statusline
```

Then in `~/.claude/settings.json`:

```json
{
  "statusLine": {"type": "command", "command": "~/.local/bin/tacho-statusline"}
}
```

**Already have a statusLine?** Keep it: chain it through `TACHO_STATUSLINE_NEXT`. Tacho's script saves the limits, then runs your command with the same input and prints its output instead of its own line:

```json
{
  "statusLine": {
    "type": "command",
    "command": "TACHO_STATUSLINE_NEXT='~/bin/my-statusline' ~/.local/bin/tacho-statusline"
  }
}
```

(Or put your command on the first line of `~/.claude/tacho-statusline-next`.) The file format is the same as the macOS app's, so a home folder shared between the two works.

### Where the numbers come from

Everything is read locally; Tacho sends nothing anywhere. The only network request is the update check (GitHub build only, can be turned off).

- **CPU** `/proc/stat`, **memory** `/proc/meminfo` (MemAvailable), **network** `/proc/net/dev` (all interfaces except `lo`).
- **GPU** Intel: idle time (RC6 / gtidle) in `/sys/class/drm`; AMD: `gpu_busy_percent`, VRAM and hwmon; NVIDIA: `nvidia-smi`, only while the card is awake (its `runtime_status`), at most every 10 s with the menu closed.
- **Temperature** `/sys/class/hwmon` — `coretemp` package, `k10temp`/`zenpower` Tctl — falling back to `/sys/class/thermal`.
- **VPN** interfaces named `tun*`, `wg*`, `ppp*`, `tailscale*` and similar in `/sys/class/net` that are up, with `/proc/net/route`.
- **Codex** `~/.codex/sessions/**/*.jsonl` (`token_count` events). **Claude Code** `~/.claude/projects/**/*.jsonl` (each response counted once) and `~/.claude/tacho-usage.json`. Logs are read incrementally once a minute, only the new bytes.
- **Docker** its API on `/var/run/docker.sock` (or rootless `$XDG_RUNTIME_DIR/docker.sock`). Your account needs to be in the `docker` group. Engine stats are only read while the menu is open.
- **Kubernetes** `~/.kube/config` (or the first file of `KUBECONFIG`), re-read only when it changes.

### Development

```bash
make test      # parser tests, needs Node 18+
make smoke     # the Gio file/socket readers under plain GJS, against fixtures
make lint      # ESLint
make check     # syntax, schema and translation checks
make pot       # refresh po/ after changing strings
```

To try changes without logging out, run a nested shell: `dbus-run-session -- gnome-shell --nested --wayland` (GNOME 45–48) or `dbus-run-session -- gnome-shell --devkit` (GNOME 49+), and watch `journalctl -f -o cat /usr/bin/gnome-shell`.

Translations: English, Vietnamese, Russian in [`po/`](po/). New languages are welcome.

### License

[MIT](LICENSE)

---

## Tiếng Việt

Tacho for GNOME là bản Ubuntu của [Tacho cho macOS](https://github.com/hieupnvmg/Tacho): cùng các chỉ số và màu sắc, dưới dạng extension cho GNOME Shell.

### Hiển thị những gì

| Chỉ số | Trên thanh trên cùng | Trong menu |
|---|---|---|
| **CPU** | % sử dụng, nhiệt độ (vàng cam từ 70 °C, đỏ từ 90 °C) | biểu đồ, nhiệt độ, tải trung bình |
| **GPU** | % sử dụng và nhiệt độ của GPU bận nhất | biểu đồ; từng GPU: % sử dụng, xung nhịp, bộ nhớ đồ hoạ, nhiệt độ, công suất. Card NVIDIA đang ngủ trên laptop hybrid chỉ hiện "Đang ngủ", không bị đánh thức |
| **Bộ nhớ** | % đã dùng | biểu đồ, đã dùng / tổng, còn trống, swap |
| **Mạng** | tốc độ tải xuống và tải lên | biểu đồ, tốc độ, các VPN đang bật |
| **AI** | khung hạn mức cao nhất của Claude Code hoặc Codex | thanh 5 giờ và 7 ngày kèm giờ đặt lại, token hôm nay |
| **Docker** | số container đang chạy | trạng thái engine, từng container có nút chạy/dừng, bộ nhớ từng container và tổng của engine |
| **Kubernetes** | bánh lái, **chuyển đỏ khi context trông như production** (tên hoặc cluster có `prod` hay `prd`) | context và namespace hiện tại, nhãn PRODUCTION màu đỏ, các context khác |

Thao tác nhanh ở cuối menu: **Giữ máy thức** (không tắt màn hình, không ngủ), **Mở System Monitor**, **Cài đặt**.

Thông báo: khi hạn mức Claude Code hoặc Codex vượt **80 %** và **95 %** (mỗi khung một lần, báo lại sau khi đặt lại), và khi một **VPN** bật hoặc tắt.

### Ba kiểu hiển thị

Chọn trong Cài đặt → Hiển thị:

- **Gộp**: một mục, mỗi chỉ số một cột (nhãn nhỏ ở trên, giá trị ở dưới) với biểu đồ lịch sử mờ phía sau. Bấm vào cột nào thì mở menu của chỉ số đó.
- **Tách, có biểu đồ**: mỗi chỉ số một mục, biểu đồ nhỏ cạnh giá trị.
- **Tách, không biểu đồ**: mỗi chỉ số một mục, chỉ có biểu tượng và giá trị.

Có thể bật/tắt từng chỉ số; CPU, bộ nhớ và mạng cập nhật mỗi 1, 2 hoặc 5 giây.

### Cài đặt

Cần GNOME Shell 45 trở lên (Ubuntu 23.10, 24.04 LTS, 24.10, 25.04 trở lên).

**Từ bản release mới nhất** (một dòng; có cả pre-release, thêm `-s -- --stable` để bỏ qua):

```bash
curl -fsSL https://raw.githubusercontent.com/hieupnvmg/tacho-gnome/main/install.sh | bash
```

Hoặc tải `tacho@hieupnvmg.github.io.shell-extension.zip` ở [Releases](https://github.com/hieupnvmg/tacho-gnome/releases) rồi chạy:

```bash
gnome-extensions install --force tacho@hieupnvmg.github.io.shell-extension.zip
```

Sau đó **đăng xuất rồi đăng nhập lại** (trên Wayland, mặc định của Ubuntu, GNOME Shell chỉ nhận extension mới khi đăng nhập; trên X11 có thể bấm <kbd>Alt</kbd>+<kbd>F2</kbd>, gõ `r`, <kbd>Enter</kbd>), rồi bật:

```bash
gnome-extensions enable tacho@hieupnvmg.github.io
```

Mở cài đặt:

```bash
gnome-extensions prefs tacho@hieupnvmg.github.io
```

### Cập nhật

Bản cài từ GitHub release tự cập nhật (OTA): cứ 6 giờ Tacho hỏi GitHub có bản mới không, báo một lần và hiện **Cập nhật Tacho lên …** trong menu. Bấm vào thì nó tải zip, kiểm SHA-256 và cài; đăng xuất rồi đăng nhập lại để dùng bản mới. Tắt hoặc bỏ qua pre-release trong Cài đặt → Cập nhật. Đây là lần duy nhất Tacho lên mạng.

Bản cho extensions.gnome.org không có phần tự cập nhật; ở đó ứng dụng Extensions của GNOME lo việc cập nhật.

### Build từ mã nguồn

```bash
sudo apt install make zip libglib2.0-bin gettext
```

```bash
git clone https://github.com/hieupnvmg/tacho-gnome.git && cd tacho-gnome && make install
```

### Phát hành

```bash
./release.sh 1.1.0 "Thay đổi gì" --pre
```

Đặt version trong `metadata.json`, chạy test, build hai zip, commit, gắn tag `v1.1.0`, push và tạo GitHub release kèm zip và `.sha256` (bỏ `--pre` cho bản chính thức). Các máy đã cài sẽ thấy bản mới trong vòng 6 giờ. File `build/ego/…zip` thì tự tải lên [extensions.gnome.org](https://extensions.gnome.org/upload/).

### Hạn mức Claude Code

Codex ghi hạn mức vào log phiên nên tự hiện. Claude Code thì không: nó chỉ đưa hạn mức 5 giờ và 7 ngày cho lệnh **statusLine**. Repo này có sẵn một lệnh nhỏ, [`tools/tacho-statusline`](tools/tacho-statusline) (bash và python3, Ubuntu có sẵn). Nó ghi hạn mức vào `~/.claude/tacho-usage.json` để Tacho đọc, và in một dòng trạng thái ngắn trong Claude Code.

```bash
install -Dm755 tools/tacho-statusline ~/.local/bin/tacho-statusline
```

Rồi trong `~/.claude/settings.json`:

```json
{
  "statusLine": {"type": "command", "command": "~/.local/bin/tacho-statusline"}
}
```

**Đã có statusLine riêng?** Giữ nguyên nó bằng cách nối qua `TACHO_STATUSLINE_NEXT`: script của Tacho lưu hạn mức, rồi chạy lệnh của bạn với cùng dữ liệu và in kết quả của lệnh đó thay cho dòng của mình:

```json
{
  "statusLine": {
    "type": "command",
    "command": "TACHO_STATUSLINE_NEXT='~/bin/my-statusline' ~/.local/bin/tacho-statusline"
  }
}
```

(Hoặc ghi lệnh của bạn vào dòng đầu của `~/.claude/tacho-statusline-next`.) Định dạng file giống bản macOS.

### Số liệu lấy từ đâu

Mọi thứ đọc trên máy; Tacho không gửi gì đi đâu. Lần lên mạng duy nhất là kiểm tra cập nhật (chỉ bản GitHub, tắt được).

- **CPU** `/proc/stat`, **bộ nhớ** `/proc/meminfo` (MemAvailable), **mạng** `/proc/net/dev` (mọi interface trừ `lo`).
- **Nhiệt độ** `/sys/class/hwmon` (`coretemp` package, `k10temp`/`zenpower` Tctl), nếu không có thì `/sys/class/thermal`.
- **VPN** các interface `tun*`, `wg*`, `ppp*`, `tailscale*`… trong `/sys/class/net` đang bật, cùng `/proc/net/route`.
- **Codex** `~/.codex/sessions/**/*.jsonl`. **Claude Code** `~/.claude/projects/**/*.jsonl` (mỗi phản hồi tính một lần) và `~/.claude/tacho-usage.json`. Log được đọc nối tiếp mỗi phút, chỉ phần mới.
- **Docker** API qua `/var/run/docker.sock` (hoặc rootless `$XDG_RUNTIME_DIR/docker.sock`). Tài khoản cần thuộc nhóm `docker`. Bộ nhớ container chỉ đọc khi menu đang mở.
- **Kubernetes** `~/.kube/config` (hoặc file đầu tiên của `KUBECONFIG`), chỉ đọc lại khi file đổi.

### Phát triển

```bash
make test      # test các parser, cần Node 18+
make check     # kiểm tra cú pháp, schema, bản dịch
```

Bản dịch: tiếng Anh, tiếng Việt, tiếng Nga trong [`po/`](po/).

### Giấy phép

[MIT](LICENSE)
