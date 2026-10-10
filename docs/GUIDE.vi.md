# Hướng dẫn dùng seatwork

English: [GUIDE.en.md](GUIDE.en.md)

Seatwork chia việc lập trình cho nhiều agent trên Paseo. Bạn giao việc cho
một agent; nó tự chia việc, tự giao tiếp và tự kiểm tra kết quả.

## 1. Ai làm gì

```text
Bạn ──────────────┬──────────────────────────┐
                  │ quản lý nhiều project    │ việc hằng ngày
                  ▼                          ▼
                 HQ ······ lệnh ······▶ Supervisor      mỗi project một cái
                                            │
                                    ┌───────┴───────┐
                                    ▼               ▼
                                  Lead            Lead   mỗi luồng việc một cái
                                    │
                            ┌───────┼───────┐
                            ▼       ▼       ▼
                          Peer    Peer    Lens
```

| Vai | Việc của nó |
|---|---|
| **Supervisor** | Nhận việc từ bạn, chia thành các luồng việc, theo dõi và báo cáo. Không sửa code. |
| **Lead** | Lo một luồng việc: lập kế hoạch, giao cho Peer, nghiệm thu. Tự làm những việc nhỏ. |
| **Peer** | Viết code cho một việc cụ thể, trong đúng các file được giao. |
| **Lens** | Chỉ đọc. Trả lời một câu hỏi khó hoặc review, độc lập với Lead. |
| **HQ** | Nhìn tổng thể nhiều project và chuyển lệnh của bạn xuống. Không tham gia làm việc. |

Ba điều cần nhớ:

- **Việc hằng ngày: chat với Supervisor** của project đó.
- **HQ chỉ để quản lý:** xem tình hình nhiều project, thêm project, gửi lệnh xuống.
- **Project không biết HQ.** Báo cáo chỉ đi lên tới Supervisor. HQ muốn biết gì thì tự đọc.

## 2. Cài đặt

Cần có Paseo 0.10.3 trở lên, `jq`, `python3` kèm PyYAML, Claude Code và Codex
(thêm Pi hoặc OpenCode nếu bạn cho vai nào chạy trên đó).

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

Lệnh cài thêm vào Paseo các "seat" (mỗi seat là một vai chạy trên Claude,
Codex, Pi hoặc OpenCode), bốn profile, plugin `slp-seat` và project `hq-seatwork`. Chạy
lại bao nhiêu lần cũng được.

### Đăng nhập Claude

Seat Claude dùng chung phiên đăng nhập với lệnh `claude` trong terminal.
Đăng nhập một lần là đủ cho mọi vai:

```bash
claude auth login
```

Seatwork không dùng token. Seat cũng không mang theo skill, plugin, hook hay
MCP server cá nhân của bạn; nó chỉ có skill của vai mình.

## 3. Thêm project

Làm một lần cho mỗi project, qua HQ.

1. Thêm thư mục project vào Paseo.
2. Trong project `hq-seatwork`, mở agent bằng profile **HQ Supervisor**.
3. Nhắn: "setup project X".
4. HQ đọc README rồi đưa bạn bản nháp **mission**: project để làm gì, thế nào
   là xong. Bạn duyệt hoặc sửa.
5. HQ hỏi project dùng bảng model chung hay bảng riêng (xem mục 7).
6. HQ đăng ký project và mở Supervisor để viết **law**, tức luật riêng của
   project: review thế nào, việc gì phải hỏi bạn trước.
7. Nhắn HQ "sao rồi". HQ đọc các câu Supervisor còn thiếu và hỏi bạn. Trả
   lời từng câu, hoặc "all recommended" để nhận hết đề xuất.
8. Nhắn HQ lần nữa để nghe xác nhận project đã sẵn sàng.

Supervisor không tự báo lên HQ, nên ở bước 7 và 8 bạn phải nhắn thì HQ mới
đi xem.

Sau project đầu tiên, Supervisor, Lead và Peer chỉ mở được trong project đã
đăng ký.

## 4. Làm việc hằng ngày

Mở agent bằng profile **Supervisor** trong workspace của project rồi nói
việc bạn cần. Một yêu cầu đủ có ba phần:

| Phần | Ví dụ |
|---|---|
| Kết quả | "Thêm lệnh `notes search <từ>`" |
| Cách nghiệm thu | "Có test, `python3 -m unittest` pass" |
| Quyền hạn | "Được commit, không push" |

Thiếu phần nào Supervisor sẽ hỏi. Sau đó nó tự làm:

1. Supervisor chia việc thành các luồng, mỗi luồng một Lead.
2. Lead chia tiếp thành task, mỗi task một Peer.
3. Peer làm xong thì nộp. Lead cho một reviewer chạy model khác kiểm tra,
   rồi nhận hoặc trả lại.
4. Supervisor báo cáo cho bạn ngay trong cuộc chat.

Bạn không cần ngồi canh. Muốn biết tiến độ thì hỏi "sao rồi".

### Đọc báo cáo của Supervisor

Dòng đầu cho biết tình trạng:

| Dòng đầu | Nghĩa |
|---|---|
| `DONE` | Xong hết, không còn gì đang chạy |
| `STATUS` | Đang làm |
| `DECISION_NEEDED` | Cần bạn quyết một việc |
| `BLOCKED` | Kẹt, không làm tiếp được |

Trong báo cáo có hai mục giúp bạn giữ quyền kiểm soát:

- **Decided by the room:** những gì các agent đã tự quyết, và bạn có thể lật lại hay không.
- **Overruled:** ý kiến phản đối của agent nào đó đã bị bác, kèm bằng chứng của nó.

Lead là người chạy phép kiểm, một lần, trên kết quả đã gộp. Supervisor đọc trạng thái room
và cây mã, rồi chép dòng của Lead lên dưới tên Lead: `Evidence (Lead <workstream>): <phép
kiểm> → <mấy dòng cuối>`. Nhờ vậy bạn phân biệt được cái đã chạy với cái chỉ được đọc.

Việc cần bạn quyết nằm ở dòng `WAITING ON YOU:` cuối báo cáo. Đó là những
việc về chi phí, phạm vi sản phẩm, hoặc hành động ra ngoài như push và
deploy. Agent không bao giờ quyết thay bạn mấy việc này.

### Muốn can thiệp một Peer

Nên nói với Supervisor. Nếu bạn chat thẳng với Peer, nó vẫn làm theo, và
báo cáo sau của nó sẽ ghi `DIRECT:` để Lead biết.

## 5. Khi nào cần HQ

| Bạn muốn | Nhắn HQ |
|---|---|
| Xem tình hình mọi project | "các project thế nào" |
| Thêm project | "setup project X" |
| Gửi lệnh xuống project | "project X dừng việc Y", "ưu tiên Z trước" |

HQ gửi lệnh cho Supervisor dưới danh nghĩa "Owner". Supervisor không biết
lệnh đến từ HQ.

## 6. Agent trao đổi với nhau thế nào

Agent gửi thư cho nhau, không ngắt lời nhau. Thư chỉ tới khi người nhận làm
xong lượt hiện tại. Kết quả đã xong (`CANDIDATE`, `REVIEW`, `DONE`) đi lên
đúng một lần, khi lượt của chính người gửi kết thúc, để không ai hành động
trên một seat còn đang làm. Thư xác nhận, hoặc `DONE` chỉ lặp lại chính nó,
không đánh thức ai: nó được đọc cùng thư kế tiếp.

| Tín hiệu | Ai gửi | Nghĩa |
|---|---|---|
| `CANDIDATE` | Peer | Có kết quả, mời kiểm tra |
| `QUESTION` | Peer | Đề bài thiếu thông tin |
| `REOPEN_REQUEST` | Peer | Đề bài sai ở đâu đó, kèm bằng chứng đã chạy thử |
| `DEPENDENCY_REQUEST` | Peer | Cần một thứ ngoài phạm vi được giao |
| `ACCEPT` / `REJECT` | Lead | Nhận, hoặc trả lại kèm việc cần sửa |
| `REVISED BRIEF` | Lead | Peer nói đúng, đề bài được sửa |
| `HOLD` / `NOTED` | Lead | Giữ hướng cũ, ý kiến của Peer được ghi lại |

Plugin kiểm tra ai được gửi thư cho ai và ai được tạo ai. Thư Peer gửi cho
Peer khác bị từ chối. Seat tạo sai luật bị lưu trữ và seat tạo ra nó được
báo lại; lúc đó lượt đầu của nó có thể đã chạy.

Các luật này để chặn nhầm lẫn, không phải hàng rào bảo mật: mọi seat chạy
bằng tài khoản của bạn, với file của bạn. Lens được dặn chỉ đọc; trên Claude
các tool sửa file bị tắt, nhưng lệnh shell vẫn ghi được.

## 7. Cấu hình riêng của project

Mỗi project có thư mục `.slp/`:

```text
.slp/
├── room.json        đánh dấu project, và bảng model riêng nếu có
├── mission.md       project để làm gì
├── <tên>-law.md     luật riêng của project
├── status.md        tiến độ, quyết định, ý kiến bị bác
└── notebook.md      bài học rút ra
```

### Bảng model riêng

Lần đầu HQ ghi giúp bạn. Về sau bạn sửa tay mục `models` trong
`.slp/room.json`. Chỉ ghi phần khác với bảng chung:

```json
{
  "models": {
    "seats": { "lead": { "thinking": "medium" } },
    "peer": {
      "tiers": {
        "default": { "thinking": "medium" },
        "cross-family": null
      }
    }
  }
}
```

Ví dụ này cho Lead và Peer bậc `default` suy nghĩ mức medium, và bỏ bậc
`cross-family`.

- Ghi `null` để bỏ một mục. Xoá cả mục `models` để quay về bảng chung.
- Thay đổi áp dụng cho agent tạo sau đó, không cần cài lại.
- Agent dùng model ngoài bảng sẽ bị từ chối.
- Ghi sai thì agent không tạo được, và lỗi chỉ rõ chỗ sai.

## 8. Cấu hình chung

Sửa trong repo rồi chạy lại lệnh cài.

| File | Quyết định | Chạy lại |
|---|---|---|
| `slp-room/paseo/seats.yml` | Harness nào (Claude, Codex, Pi, OpenCode) được bật cho từng vai; vai chạy trên harness nào là `models.json` | `./install.sh` |
| `slp-room/room/models.json` | Mỗi vai dùng model nào | `./install.sh --no-plugin` |
| `slp-room/paseo/policy.json` | Ai gửi thư cho ai, ai tạo ai, thời gian chờ | `./install.sh` |
| `slp-room/room/roles/`, `skills/` | Prompt và quy trình của từng vai | `./install.sh --no-plugin` |

Các bậc model của Peer. Bảng đi kèm có hai bậc; muốn thêm bậc `cheap` hay
`expensive` thì thêm một mục nữa dưới `peer.tiers`:

| Bậc | Dùng cho |
|---|---|
| `default` | Viết code, debug, research |
| `cross-family` | Review code do họ model khác viết |

Bảng Lens có `oracle` (một lens), `hard` (một lens cho câu hỏi khó), `pair`
(hai lens, hai model khác nhau) và `pool` (lens thứ ba).

## 9. File nằm ở đâu

```text
~/.config/slp-room/
├── hq-seatwork/         thư mục làm việc của HQ
├── room/                prompt, skill, bảng model đang dùng
├── role-skills/         skill theo vai cho seat Claude
├── runtimes/            môi trường riêng của seat Codex, Pi, OpenCode
├── mail/                thư và nhật ký thư
├── projects.json        các project đã đăng ký
├── registry-log.jsonl   các agent đã tạo
└── gc.log               nhật ký dọn dẹp
```

Phiên làm việc của seat Claude nằm trong `~/.claude/projects`, chung chỗ với
phiên của bạn.

## 10. Tự dọn dẹp

Cứ 10 phút plugin lưu trữ những agent đã rảnh quá lâu và không còn agent
con đang chạy. Agent đang chờ cấp quyền hoặc chờ trả lời thì được để yên.

| Vai | Rảnh bao lâu thì lưu trữ |
|---|---|
| HQ | Không bao giờ |
| Supervisor | 7 ngày |
| Lead, Peer | 48 giờ |
| Lens | 12 giờ |

## 11. Lỗi thường gặp

| Thông báo | Cách xử lý |
|---|---|
| `may only be created in the hq-seatwork project` | Mở HQ trong project `hq-seatwork` |
| `holds only hq seats` | Vai này phải mở trong project của nó |
| `is not a registered SLP project` | Nhờ HQ setup project trước |
| `lists for … only …` | Dùng model có trong bảng, hoặc sửa `.slp/room.json` |
| `which the room has not enabled` | Sửa `.slp/room.json`, hoặc bật seat đó trong `seats.yml` |
| `its runtime could not be built` | Sửa thứ thông báo nêu ra (thường là `~/.codex/config.toml`), rồi tạo lại agent |
| Agent báo chưa đăng nhập | Chạy `claude auth login` |
| Agent không biết quy trình mới | Mở agent mới |

Xem nhật ký của plugin:

```bash
paseo plugin logs slp-seat
```
