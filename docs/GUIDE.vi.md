# Hướng dẫn sử dụng seatwork

Bản tiếng Anh: [GUIDE.en.md](GUIDE.en.md)

seatwork biến Paseo thành một "phòng làm việc" của các agent, chia theo
tầng. Bạn có hai người để nói chuyện: **Supervisor** của từng project cho
công việc hằng ngày, và **HQ** cho việc quản lý nhiều project. Các project
không biết HQ tồn tại và không gửi gì lên HQ.

## Mục lục

1. [Mô hình](#1-mô-hình)
2. [Cài đặt](#2-cài-đặt)
3. [Bắt đầu: ai để chat](#3-bắt-đầu-ai-để-chat)
4. [Thêm một project mới](#4-thêm-một-project-mới)
5. [Giao việc hằng ngày: chat với Supervisor](#5-giao-việc-hằng-ngày-chat-với-supervisor)
6. [Các agent nói chuyện với nhau thế nào](#6-các-agent-nói-chuyện-với-nhau-thế-nào)
7. [Cấu hình theo project](#7-cấu-hình-theo-project)
8. [Cấu hình toàn phòng](#8-cấu-hình-toàn-phòng)
9. [File nằm ở đâu](#9-file-nằm-ở-đâu)
10. [Dọn dẹp tự động](#10-dọn-dẹp-tự-động)
11. [Xử lý sự cố](#11-xử-lý-sự-cố)

---

## 1. Mô hình

```text
                          Bạn
            ┌──────────────┴──────────────────────────┐
            │ quản lý: tình hình chung,                │ việc hằng ngày
            │ thêm project, lệnh đưa xuống             │ của một project
            ▼                                          │
  ┌───────────────────┐                                │
  │        HQ         │   project: hq-seatwork         │
  │  nhìn xuống, ra   │   project không biết HQ,       │
  │  lệnh xuống       │   không gửi gì lên HQ          │
  └─────────┬─────────┘                                │
            ┆ lệnh xuống (hiếm)                        │
            ├──────────────────────────────┐           │
            ▼                              ▼           ▼
   ┌─────────────────┐           ┌─────────────────────┐
   │   Supervisor    │           │   Supervisor        │   mỗi project một cái
   │   project A     │           │   project B         │
   └────────┬────────┘           └─────────────────────┘
       ┌────┴─────┐
       ▼          ▼
   ┌───────┐  ┌───────┐
   │ Lead  │  │ Lead  │                              mỗi luồng việc một cái
   └───┬───┘  └───────┘
   ┌───┼────────┐
   ▼   ▼        ▼
 Peer  Peer    Lens                                  Peer viết, Lens chỉ đọc
```

| Vai | Làm gì | Không bao giờ làm |
|---|---|---|
| **HQ** | Quản lý: trả lời tình hình chung các project, thêm project mới, chuyển lệnh của bạn xuống Supervisor khi cần | Nhận việc hằng ngày, tham gia làm việc, tạo Lead hay Peer, sửa code |
| **Supervisor** | Chốt mục tiêu của một project, chia thành luồng việc, giữ các Lead đi đúng hướng; việc cần bạn quyết thì ghi vào báo cáo cuối lượt | Sửa code, nghiệm thu, gửi thư lên trên |
| **Lead** | Lập kế hoạch một luồng việc, giao cho Peer, kiểm tra và nghiệm thu kết quả; tự làm việc nhỏ và dựng khung ban đầu | Sửa phạm vi của Peer, làm việc lớn một mình |
| **Peer** | Làm một việc cụ thể trong một phạm vi file được giao | Sửa ngoài phạm vi |
| **Lens** | Trả lời một câu hỏi khó hoặc review, độc lập với Lead | Sửa bất cứ thứ gì |

Hai nguyên tắc cần nhớ:

- **Việc hằng ngày đi thẳng vào Supervisor.** Mỗi project có một
  Supervisor; bạn chat với nó để giao việc, trả lời câu hỏi, nhận báo cáo.
- **HQ chỉ để quản lý.** Bạn chat với HQ khi cần tình hình chung của nhiều
  project, khi thêm project mới, hoặc khi có lệnh muốn đưa xuống một
  project. HQ tự nhìn xuống (báo cáo cuối lượt của Supervisor,
  `.slp/status.md`) khi bạn hỏi; không có gì tự chạy lên HQ.
- **Project không biết HQ.** Agent trong project chỉ biết có một "Owner"
  phía trên; chúng không biết HQ hay bạn tồn tại, không thể gửi thư lên HQ,
  và báo cáo của chúng dừng ở Supervisor.
- **Mỗi vai là một trách nhiệm.** Lead quyết định nhưng không sửa code;
  Peer sửa code nhưng không tự mở rộng phạm vi.

Một "seat" (chỗ ngồi) là một provider của Paseo tên `<harness>-<vai>`, ví
dụ `claude-lead`, `codex-peer`. Harness là công cụ chạy agent: claude,
codex, pi, opencode.

---

## 2. Cài đặt

**Cần có:** Paseo 0.10.3 trở lên, `jq`, `python3` kèm PyYAML, và ít nhất
một harness đã đăng nhập (mặc định là Claude Code, thêm Codex cho Peer và
Lens).

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

Lệnh cài làm bốn việc:

1. Chép prompt, skill và bảng model vào `~/.config/slp-room/`.
2. Ghi các seat và 4 profile (HQ Supervisor, Supervisor, Lead, Peer) vào
   cấu hình Paseo. File cấu hình cũ được sao lưu bên cạnh.
3. Cài plugin `slp-seat` vào Paseo.
4. Plugin tự tạo project `hq-seatwork`, là chỗ ở của HQ.

Chạy lại `./install.sh` bao nhiêu lần cũng được; nó không tạo trùng.

---

## 3. Bắt đầu: ai để chat

| Bạn muốn | Chat với | Ở đâu |
|---|---|---|
| Giao việc, hỏi tiến độ, trả lời câu hỏi của một project | **Supervisor** của project đó | profile **Supervisor**, trong workspace của project |
| Tình hình chung của nhiều project | **HQ** | profile **HQ Supervisor**, trong project `hq-seatwork` |
| Thêm project mới vào phòng | **HQ** | như trên |
| Đưa một lệnh xuống một hoặc nhiều project (đổi ưu tiên, dừng, đổi hướng) | **HQ** | như trên |

Lần đầu bạn cần HQ một lần để thêm project ([mục 4](#4-thêm-một-project-mới)).
Sau đó công việc hằng ngày không đi qua HQ nữa.

HQ chỉ mở được trong `hq-seatwork`, và trong `hq-seatwork` chỉ mở được HQ.
Supervisor chỉ mở được trong project đã đăng ký. Mở sai chỗ thì Paseo báo
lỗi kèm lý do.

---

## 4. Thêm một project mới

Bạn chỉ làm hai việc: thêm thư mục vào Paseo, rồi nói với HQ.

```text
 Bạn                    HQ                         Supervisor của project
  │                      │                                  │
  │ 1. add project       │                                  │
  │    vào Paseo         │                                  │
  │                      │                                  │
  │ 2. "setup project X" │                                  │
  ├─────────────────────▶│ đọc README                       │
  │                      │                                  │
  │ 3. nháp mission      │                                  │
  │    + hỏi bảng model  │                                  │
  │◀─────────────────────┤                                  │
  │ 4. "yes" / sửa       │                                  │
  ├─────────────────────▶│ đăng ký project                  │
  │                      │ 5. mở Supervisor ───────────────▶│ viết law
  │                      │                                  │
  │                      │                                  │ ghi câu hỏi còn
  │ 6. bạn hỏi tiếp      │                                  │ thiếu vào báo cáo
  ├─────────────────────▶│ nhìn xuống: đọc báo cáo ········▶│
  │    câu hỏi về law    │                                  │
  │◀─────────────────────┤                                  │
  │ 7. trả lời           │                                  │
  ├─────────────────────▶├─────────────────────────────────▶│ chốt law
  │                      │                                  │
  │ 8. bạn hỏi tiếp      │ nhìn xuống: đọc DONE ···········▶│
  ├─────────────────────▶│                                  │
  │   "project sẵn sàng" │                                  │
  │◀─────────────────────┤                                  │
```

Mũi tên chấm là HQ tự đọc; Supervisor không gửi gì lên. Vì vậy sau bước 5
bạn nhắn HQ một câu bất kỳ ("sao rồi") để nó nhìn xuống.

Giải thích từng thứ được tạo ra:

- **Mission** (`.slp/mission.md`): vài dòng nói project để làm gì, ai dùng,
  thế nào là xong, cái gì nằm ngoài phạm vi. HQ nháp từ README, bạn duyệt.
- **Bảng model**: HQ hỏi dùng bảng chung của phòng hay bảng riêng cho
  project. Xem [mục 7](#7-cấu-hình-theo-project).
- **Law** (`.slp/<tên-project>-law.md`): luật riêng của project, ví dụ mức
  nghiêm ngặt, cách review, việc nào phải hỏi bạn trước (push, deploy).
  Supervisor tự điền những gì đọc được từ repo và chỉ hỏi phần còn lại.
  Trả lời "all recommended" để nhận hết đề xuất của nó.

> **Lưu ý:** project đầu tiên được đăng ký sẽ bật "chế độ đăng ký". Từ đó
> Supervisor, Lead, Peer chỉ mở được trong project đã đăng ký. Project khác
> muốn dùng phòng thì cũng thêm qua HQ.

---

## 5. Giao việc hằng ngày: chat với Supervisor

Mở (hoặc mở lại) agent profile **Supervisor** trong workspace của project và
nói điều bạn muốn, bằng lời thường. Bạn chính là "Owner" của nó: nó đọc lời
bạn, bạn đọc báo cáo của nó. Một yêu cầu tốt có ba thứ:

| Thành phần | Ví dụ |
|---|---|
| Kết quả mong muốn | "Thêm lệnh `notes search <từ>`" |
| Bằng chứng nghiệm thu | "Có test, `python3 -m unittest` pass" |
| Quyền hạn | "Được commit local, không push" |

Thiếu thứ nào Supervisor sẽ hỏi lại. Sau đó:

```text
 Bạn ──▶ Supervisor ──▶ Lead ──▶ Peer      việc đi xuống
                                  │
                              kết quả
                                  ▼
 Bạn ◀── Supervisor ◀── Lead ◀── Lens/review   báo cáo đi lên, dừng ở Supervisor
```

1. Supervisor chốt mục tiêu với bạn và chia thành luồng việc, mỗi luồng
   một Lead.
3. Lead chia thành task, mỗi task một Peer với phạm vi file rõ ràng.
4. Peer làm xong gửi kết quả; Lead cho một reviewer khác dòng model kiểm
   tra, rồi chấp nhận hoặc trả về sửa.
5. Xong hết thì Supervisor ghi kết quả vào báo cáo cuối lượt và
   `.slp/status.md`.

Việc nhỏ (sửa nhanh, vài file, kiểm tra được ngay) và việc dựng khung ban
đầu thì Lead tự làm, không mở Peer.

Báo cáo của Supervisor luôn có hai mục để bạn giữ quyền kiểm soát: **phòng
đã tự quyết gì** (và bạn có thể lật lại không) và **ý kiến nào bị bác** (Peer
phản đối kèm bằng chứng nhưng không được theo). Hai mục này cũng nằm trong
`.slp/status.md`, không bao giờ bị tóm tắt mất.

Khi có việc cần bạn quyết (chi phí, phạm vi sản phẩm, hành động ra bên ngoài
như push hay deploy), Supervisor ghi vào dòng `WAITING ON YOU:` cuối báo
cáo, kèm đề xuất và hệ quả, và chờ bạn trả lời trong chính cuộc chat đó.
Nó không bao giờ quyết thay bạn.

Hỏi tiến độ của project bất cứ lúc nào, cũng trong cuộc chat đó: "sao rồi".

### Khi nào mới cần HQ

- **Tình hình chung:** "các project thế nào". HQ đọc báo cáo cuối lượt và
  `.slp/status.md` của từng Supervisor rồi tổng hợp, kể cả mục *phòng đã tự
  quyết gì* và *ý kiến bị bác* của mỗi project. HQ cũng đếm được từ nhật ký
  thư (`slp_room_stats`): bao nhiêu kết quả được nhận hay trả về, bao nhiêu
  lần Peer chất vấn và được chấp nhận.
- **Thêm project** ([mục 4](#4-thêm-một-project-mới)).
- **Lệnh đưa xuống:** đổi ưu tiên, dừng một việc, đổi hướng cho một hay
  nhiều project. HQ gửi thành thư cho Supervisor liên quan; với Supervisor
  đó là lệnh "từ Owner", không có dấu vết của HQ hay của bạn.

HQ không nhận việc hằng ngày và không chuyển kết quả lên cho bạn: project
không gửi gì lên HQ, HQ chỉ nhìn xuống khi bạn hỏi.

**Can thiệp vào Peer:** nên đi qua Supervisor hoặc Lead. Nếu bạn chat thẳng
với một Peer, nó làm theo, và báo cáo kế tiếp của nó mở bằng `DIRECT:` để
Lead biết có người đã chỉ đạo ngoài thư.

---

## 6. Các agent nói chuyện với nhau thế nào

Agent không ngắt lời nhau. Chúng gửi thư, và thư chỉ được đưa tới khi người
nhận xong lượt đang làm.

```text
   Peer đang làm                  Lead đang bận
        │                              │
        │── thư: CANDIDATE ───▶ [ giữ lại ]
        │                              │  xong lượt
        │                        [ giao thư ]
        │                              ▼
        │◀──── thư: ACCEPT ──── Lead xử lý
```

Dòng đầu của mỗi báo cáo là một tín hiệu:

| Tín hiệu | Ai gửi | Nghĩa |
|---|---|---|
| `CANDIDATE` | Peer | Có kết quả, mời kiểm tra |
| `QUESTION` | Peer | Đề bài thiếu thông tin |
| `REOPEN_REQUEST` | Peer | Tiền đề của đề bài sai, kèm bằng chứng |
| `DEPENDENCY_REQUEST` | Peer | Cần một thứ nằm ngoài phạm vi |
| `BLOCKED` | mọi vai | Không thể làm tiếp một cách an toàn |
| `ACCEPT` / `REJECT` | Lead | Chấp nhận, hoặc trả về kèm việc cần sửa |
| `REVISED BRIEF` | Lead | Peer chất vấn đúng, đề bài được sửa |
| `HOLD` / `NOTED` | Lead | Giữ hướng hiện tại; ý kiến của Peer được ghi lại, không tranh luận thêm |
| `DECISION_NEEDED` | Lead, Supervisor | Cần cấp trên quyết |
| `DONE` | mọi vai | Xong, không còn gì đang chạy |

Ai được gửi thư cho ai và ai được tạo ai đều do plugin kiểm soát, không dựa
vào việc agent "ngoan". Ví dụ Peer không thể gửi thư cho Peer khác, HQ không
thể tạo Lead.

---

## 7. Cấu hình theo project

Mỗi project có thư mục `.slp/` riêng:

```text
<project>/.slp/
├── room.json            đánh dấu project + bảng model riêng (nếu có)
├── mission.md           project để làm gì
├── <tên>-law.md         luật riêng của project
├── status.md            tiến độ, quyết định phòng tự đưa ra, ý kiến bị bác
└── notebook.md          bài học rút ra
```

### Bảng model riêng

Lần đầu, HQ hỏi và ghi giúp bạn. Những lần sau, sửa tay mục `models` trong
`.slp/room.json`. Chỉ ghi phần **khác** với bảng chung
(`~/.config/slp-room/room/models.json`):

```json
{
  "models": {
    "seats": {
      "lead": { "thinking": "medium" }
    },
    "peer": {
      "tiers": {
        "default": { "providers": ["claude-peer/claude-opus-5-5"] },
        "expensive": null
      }
    }
  }
}
```

Ví dụ trên: Lead suy nghĩ mức medium, Peer bậc `default` dùng Opus, bỏ bậc
`expensive`.

| Quy tắc | Chi tiết |
|---|---|
| Cách ghi đè | Object được trộn theo từng khoá; danh sách và giá trị thì thay thế; `null` xoá khoá |
| Khi nào có hiệu lực | Với seat tạo **sau** khi sửa. Seat đang chạy giữ bảng cũ. Không cần cài lại |
| Được chọn gì | Chỉ seat đã bật trong `seats.yml` |
| Có bị ép không | Có. Seat dùng model ngoài bảng bị từ chối |
| Sửa sai thì sao | Seat không tạo được, lỗi nêu rõ dòng nào sai |

Xoá mục `models` để quay về bảng chung.

---

## 8. Cấu hình toàn phòng

Các file dưới đây nằm trong repo; sửa xong thì chạy lại lệnh cài:

| File | Quyết định | Sau khi sửa |
|---|---|---|
| `slp-room/paseo/seats.yml` | Harness nào được ngồi vai nào | `./install.sh` |
| `slp-room/room/models.json` | Mỗi vai dùng model nào, các bậc của Peer, các Lens | `./install.sh --no-plugin` |
| `slp-room/paseo/policy.json` | Ai gửi thư cho ai, ai tạo ai, ngưỡng chờ, dọn dẹp | `./install.sh` |
| `slp-room/room/roles/`, `skills/` | Prompt của từng vai và quy trình | `./install.sh --no-plugin` |

Bậc của Peer trong `models.json`:

| Bậc | Dùng cho |
|---|---|
| `cheap` | Việc máy móc, đề bài đã rõ hoàn toàn |
| `default` | Cài đặt, debug, sửa nhiều file |
| `expensive` | Quyết định kiến trúc, bug khó, việc đã thất bại ở bậc default |
| `cross-family` | Reviewer khác dòng model với người viết |

---

## 9. File nằm ở đâu

```text
~/.config/slp-room/
├── hq-seatwork/         thư mục làm việc của HQ
├── room/                prompt, skill, models.json (bản đang dùng)
├── runtimes/            môi trường cách ly cho từng seat
├── mail/                thư và nhật ký thư (log.jsonl)
├── policy.json          luật của phòng (bản đang dùng)
├── seats.json           seat đang bật
├── projects.json        project đã đăng ký (có sau lần đăng ký đầu)
├── registry-log.jsonl   mọi seat từng được tạo
└── gc.log               nhật ký dọn dẹp
```

Phòng không ghi gì vào `~/.claude`, `~/.codex`, `~/.pi` hay
`~/.config/opencode`. Mỗi seat chạy trong môi trường riêng, không thừa
hưởng skill, plugin hay MCP server cá nhân của bạn.

---

## 10. Dọn dẹp tự động

Cứ 10 phút plugin quét một lần và lưu trữ (archive) seat đã rảnh quá lâu,
trừ khi nó còn seat con đang sống:

| Vai | Rảnh bao lâu thì bị lưu trữ |
|---|---|
| HQ | Không bao giờ |
| Supervisor | 7 ngày |
| Lead, Peer | 48 giờ |
| Lens | 12 giờ |

Seat cha được báo khi seat con bị lưu trữ. Thư còn giữ cho seat đã lưu trữ
được trả về người gửi. Plugin không kill tiến trình nào.

---

## 11. Xử lý sự cố

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| "may only be created in the hq-seatwork project" | Mở HQ ngoài `hq-seatwork` | Mở trong project `hq-seatwork` |
| "holds only hq seats" | Mở vai khác trong `hq-seatwork` | Mở trong project của nó |
| "is not a registered SLP project" | Chế độ đăng ký đang bật, project chưa đăng ký | Nhờ HQ setup project đó |
| "refused: project … lists for … only …" | Model không có trong bảng của project | Dùng model trong bảng, hoặc sửa `.slp/room.json` |
| "names …, which the room has not enabled" | `room.json` ghi seat chưa bật | Sửa lại, hoặc bật seat trong `seats.yml` rồi cài lại |
| "is not enabled in paseo/seats.yml" | Seat chưa bật | Bật trong `seats.yml`, chạy `./install.sh` |
| HQ không biết quy trình mới | Agent mở trước khi cập nhật | Mở một HQ mới |
| Không thấy project `hq-seatwork` | Plugin chưa nạp | `paseo plugin reload slp-seat` |

Xem nhật ký:

```bash
paseo plugin logs slp-seat
```

```bash
tail -f ~/.config/slp-room/mail/log.jsonl
```

```bash
tail -f ~/.config/slp-room/gc.log
```
