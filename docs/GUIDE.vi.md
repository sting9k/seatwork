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

Cần có Paseo 0.11.2 trở lên, Claude Code và Codex (thêm Pi từ 0.99 trở lên,
hoặc OpenCode, nếu bạn cho vai nào chạy trên đó).

### Cài từ Paseo

1. Mở Settings, Plugins. Dán dòng này vào ô "Plugin source" rồi bấm
   **Install plugin**:

   ```
   git:sting9k/seatwork:slp-room/plugin
   ```

   Cài xong chưa có gì được tạo: chưa có thư mục, chưa có seat.

2. Trong menu "…" của plugin, chọn **Seatwork**. Màn hình có một dòng cho
   mỗi vai: HQ, Supervisor, Lead, Peer, Lens. Bấm một dòng để chọn agent
   CLI, model (danh sách có ô tìm) và mức thinking, trong những thứ máy này
   có. Peer và Lens mỗi vai là một, nhưng gán được nhiều model, mỗi model
   mang một tên như `cheap`, `high`, `extra` kèm một dòng nói nó dùng cho
   việc gì; thêm bớt ngay tại đó. Lead đọc các tên này rồi tự chọn. Bên dưới
   các vai là chế độ của watcher (mục 11) và âm báo.

3. Bấm **Init**. Nó tạo thư mục của room (`~/.config/slp-room`), các "seat"
   trong Paseo (mỗi seat là một vai chạy trên Claude, Codex, Pi hoặc
   OpenCode), bốn profile và project `hq-seatwork`. Không cần khởi động lại
   gì.

Muốn đổi lựa chọn về sau: đổi trên chính màn hình đó rồi bấm **Apply**.
Chọn model cho một vai là seat của vai đó được dựng.

Nút **Remove the room** trên màn hình đó gỡ các seat và profile khỏi Paseo,
rồi chuyển thư mục của room sang bên cạnh
(`~/.config/slp-room.removed-<thời điểm>`), giữ nguyên thư và log. Nó chờ tới
khi mọi agent của room đã được lưu trữ. Chỉ gỡ plugin thì không hoàn tác được
Init.

### Cài từ terminal

Dùng cho máy không có app, hoặc khi bạn muốn sửa file của chính room. Cần
`node` và `npm`:

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

Lệnh làm đúng việc của Init, chạy lại bao nhiêu lần cũng được. Lần chạy đầu
nó hỏi hai câu: HQ chạy trên seat mặc định của room hay trên agent CLI và
model bạn tự chọn, và có cài watcher không (trả lời có thì cài ở chế độ
`shadow`). Trả lời sẵn bằng cờ: `--hq default`, `--hq <harness>/<model>`
(thêm `--hq-thinking <mức>` nếu cần), `--watcher off`, `shadow` hoặc `on`.
Room cài theo cách này vẫn hiện trên màn hình cài đặt với đúng các lựa chọn
nó đang chạy.

### Đăng nhập Claude

Seat Claude dùng chung phiên đăng nhập với lệnh `claude` trong terminal.
Đăng nhập một lần là đủ cho mọi vai:

```bash
claude auth login
```

Seatwork không dùng token. Seat cũng không mang theo skill, plugin, hook hay
MCP server cá nhân của bạn; nó chỉ có skill của vai mình. Những thứ Claude
Code tự thêm cũng bị tắt trong seat: memory, agent teams và các công cụ task
của nó, agent view, workflows, routine trên cloud và connector của claude.ai.
Các công tắc tách
seat khỏi cấu hình cá nhân của bạn nằm ngay trong provider của seat ở cấu
hình Paseo, nên chúng vẫn có hiệu lực cả khi plugin không chạy.

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

Khi app Paseo đang mở, nó phát một tiếng ngắn mỗi lần HQ, một Supervisor
hoặc một seat do chính bạn mở kết thúc lượt bằng `DECISION_NEEDED`,
`BLOCKED`, một dòng `WAITING ON YOU:`, hoặc bị lỗi. Muốn tắt: gạt công tắc
Chime trên màn hình cài đặt.

Dòng **Room** ở chân sidebar của Paseo cho biết còn bao nhiêu lượt như vậy
đang chờ, và mở một màn hình cho cả room: các lượt đó ở trên cùng, rồi mỗi
dòng là HQ hoặc một project đang có seat, kèm một chấm cho mỗi seat (xanh
khi seat đang làm việc). Bấm vào project để xem cây seat của nó, bấm vào
seat để mở seat đó. Các project chưa có seat nào nằm chung một dòng ở cuối. Một lượt nằm trong danh sách cho tới khi seat đó làm việc
lại hoặc bị lưu trữ; khởi động lại daemon không xoá nó.

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
trên một seat còn đang làm. Thư dài bao nhiêu cũng tới nơi nguyên vẹn.

Seat không cần đang mở mới nhận được thư. Sau khi daemon khởi động lại, mọi
agent đều đóng cho tới khi có thứ gì mở nó, và thư sẽ mở nó. Thư đã nằm chờ
từ trước lúc daemon tắt sẽ đi khi app Paseo đang mở hoặc khi có agent nào chạy. Seat vừa có
lượt chạy bị lỗi cũng nhận thư như vậy. Thư gửi cho seat đã lưu trữ hoặc đã
bị xoá sẽ quay về người gửi với tiêu đề `UNDELIVERABLE`.

Có những thư không đánh thức ai, chỉ được đọc cùng thư kế tiếp: thư xác
nhận, `DONE` chỉ lặp lại chính nó, `STATUS` của Lead sau báo cáo đầu tiên,
và `HOLD` không cần trả lời gửi cho Peer đang chờ kết quả kiểm tra. Trong các
`STATUS` của một Lead, room chỉ giữ bản mới nhất; Supervisor đọc nó ở nhịp
heartbeat.

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
`.slp/room.json`. Chỉ ghi phần khác với bảng chung. Vai nào cũng chạy được
trên harness nào (`<harness>-<vai>/<model>`): seat nào room chưa có thì HQ
dựng luôn lúc ghi bảng. Sửa tay mà thêm seat mới thì nhờ HQ ghi lại bảng
(nếu có bản clone: `./install.sh --seat <harness>-<vai>`):

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

| Ở đâu | Quyết định | Có hiệu lực khi |
|---|---|---|
| Màn hình cài đặt (Settings, Plugins, Seatwork) | Agent CLI, model và mức thinking của từng vai; chế độ của watcher; âm báo | Bấm **Apply** |
| `~/.config/slp-room/setup.json` | Những gì màn hình đã áp dụng, các seat HQ dựng thêm cho project, và `mailPort` khi cổng trong policy đã có chương trình khác dùng | Bấm **Apply**, hoặc chạy `./install.sh` |
| `slp-room/plugin/paseo/seats.json` | Các seat mà máy nào cài cũng có | xem bên dưới |
| `slp-room/plugin/room/models.json` | Bảng model của room: điểm bắt đầu của màn hình | xem bên dưới |
| `slp-room/plugin/paseo/policy.json` | Ai gửi thư cho ai, ai tạo ai, thời gian chờ, các luật của watcher | xem bên dưới |
| `slp-room/plugin/room/roles/`, `skills/` | Prompt và quy trình của từng vai | xem bên dưới |

Bốn dòng cuối là file của plugin. Có bản clone thì sửa rồi chạy
`./install.sh`. Plugin cài từ Paseo nhận bản mới bằng
`paseo plugin update slp-seat`; sau đó bấm **Apply**.

Peer là một vai với nhiều model, mỗi model mang một tên trong `peer.tiers`.
Bảng đi kèm có ba; màn hình cài đặt thêm được tên mới (ví dụ `expensive`)
hoặc bỏ bớt. Lead chọn theo việc:

| Bậc | Dùng cho |
|---|---|
| `cheap` | Việc máy móc, đã tả rõ: đổi tên, định dạng, lọc log, sửa tài liệu. Chạy Claude Haiku 5.5, cần Claude Code từ 2.1.293 |
| `default` | Viết code, debug, research |
| `cross-family` | Review code do họ model khác viết |

Lens cũng là một vai, các model liệt kê y như vậy trong `lens.tiers` (bảng
đi kèm có `default`, `high` cho câu hỏi khó, `extra` thuộc họ model khác).
Lead chọn theo câu hỏi; khi mở hai lens thì luôn là hai model khác nhau.

## 9. File nằm ở đâu

```text
~/.config/slp-room/
├── hq-seatwork/         thư mục làm việc của HQ
├── room/                prompt, skill, bảng model đang dùng
├── role-skills/         skill theo vai cho seat Claude
├── runtimes/            môi trường riêng của seat Codex, Pi, OpenCode
├── mail/                thư và nhật ký thư
├── setup.json           lựa chọn của máy này: seat của HQ, seat dựng thêm, watcher
├── projects.json        các project đã đăng ký
├── registry-log.jsonl   các agent đã tạo
├── watch/               watcher: khoá, nhật ký quét, chi phí từng tháng
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

## 11. Watcher

Plugin đọc mọi lượt của Lead và Peer: các lệnh gọi công cụ và câu trả lời
cuối, không đọc phần suy nghĩ. Khi một lượt có dấu hiệu đi sai, seat phía
trên nhận một thư từ `room` có tiêu đề bắt đầu bằng `OBSERVATION` (của Peer
thì báo Lead, của Lead thì báo Supervisor). Watcher không dừng hay sửa seat
nào, và không giữ trí nhớ giữa các lượt.

Chế độ của nó là mục Watcher trên màn hình cài đặt (cài từ terminal thì lệnh
cài hỏi một lần), được giữ trong `~/.config/slp-room/setup.json`:

| Chế độ (mục Watcher trên màn hình, hoặc `./install.sh --watcher <chế độ>`) | Điều xảy ra |
|---|---|
| `off` (khi bạn chưa trả lời có) | Không đọc gì |
| `shadow` (khi trả lời có lúc cài) | Đọc lượt và ghi nhật ký; không gửi thư cho ai |
| `on` | Gửi thêm thư, nhiều nhất một thư mỗi lượt |

Mười luật dựa hoàn toàn vào lệnh gọi công cụ và vào brief, không tốn tiền:

| Luật | Báo khi seat |
|---|---|
| `irreversible` | chạy lệnh không hoàn tác được từ trong việc đang làm (`git reset --hard`, xoá đệ quy ngoài phạm vi, push đè) |
| `outside-project` | ghi file ra ngoài project |
| `outside-scope` | sửa file nằm ngoài phạm vi ghi của brief |
| `edit-after-reopen` | đã gửi `REOPEN_REQUEST` mà vẫn sửa code tiếp |
| `review-without-check` | đưa `REVIEW` chấp nhận trong khi không chạy kiểm tra nào |
| `same-failure` | chạy cùng một kiểm tra 4 lần, hỏng y như nhau |
| `repeating` | làm cùng một việc 4 lần liền, kết quả y như nhau |
| `shell-wait` | chờ trong shell đủ một phút (`sleep`, vòng lặp có sleep) |
| `silent` | đang trong lượt mà không hoạt động quá thời gian chờ của vai |
| `incomplete-brief` | là Peer nhận từ Lead một brief thiếu `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` hoặc dòng cuối `Reply with slp_mail to: owner` (brief viết tự do thì thiếu cả năm). Luật xét cả brief lúc tạo Peer lẫn brief gửi sau đó qua thư (thư có chữ `BRIEF` trong tiêu đề); mỗi brief báo một lần, lúc lượt mà nó mở ra bắt đầu |

Bốn luật cần người đọc câu trả lời của seat. Code quyết định lúc nào hỏi (ví
dụ: câu trả lời báo xong việc, code đã đổi, và không có test nào qua sau lần
sửa cuối), model phân loại đọc xem câu trả lời khẳng định gì, rồi code so
hai bên. Khi cài, luật đầu ở mức `raise`; ba luật còn lại ở mức `log`: chỉ
ghi điểm vào nhật ký, không gửi thư cho tới khi bạn đổi sang `raise` trong
`policy.json`.

| Luật | Hỏi khi |
|---|---|
| `unverified-completion` | câu trả lời nói về kiểm tra, mà không có test nào đứng sau lần sửa cuối |
| `external-action` | seat đã push, publish hoặc deploy, và brief có ràng buộc |
| `decided-beyond-brief` | câu trả lời báo một quyết định của riêng seat |
| `reopen-condition` | brief có dòng `Reopen when` và seat không xin mở lại |

Model phân loại là Jev, gọi qua OpenRouter. Dán khoá vào mục Watcher key
trên màn hình cài đặt; khoá được lưu ở `~/.config/slp-room/watch/key`
(quyền 600) và không hiện lại nữa. Biến môi trường `SLP_WATCH_KEY` cũng dùng
được. Không có khoá thì mười luật dựa vào lệnh vẫn chạy. Thứ được
gửi đi: các dòng brief mà câu hỏi cần, tên các file đã đổi, và câu trả lời
cuối của seat sau khi đã che bí mật. Câu trả lời dài tới 12.000 ký tự được
gửi nguyên; dài hơn thì chỉ gửi các dòng câu hỏi cần đọc, và câu hỏi nào
không đủ chỗ cho các dòng của nó thì bị bỏ qua, có ghi tên trong nhật ký.
Output của công cụ không bao giờ được gửi. Chi phí được đếm từ mỗi lần trả lời; `watcher.budget` đặt kế hoạch 6
USD một tháng và ngừng hỏi ở 10 USD. Chi phí trong tháng hiện ở mục Usage của
Paseo, dưới tên "Room watcher".

Muốn bật: để chạy `shadow` một thời gian, nhờ HQ xem số liệu watcher (HQ gọi
`slp_watch_stats`: chi phí, số lượt đã theo dõi và số lần đọc, và với từng
luật là nó lên tiếng bao nhiêu lần, trong đó bao nhiêu lượt bị seat phía
trên trả lại), rồi chọn On ở mục Watcher trên màn hình cài đặt và bấm Apply
(hoặc chạy `./install.sh --watcher on`). Với
`unverified-completion`, một lượt bị trả lại chỉ được tính khi seat phía trên
tự chạy test và thấy hỏng: bài còn bị trả lại vì nhiều lý do khác.

Muốn thử luật trên các lượt đã ghi lại mà không đụng tới room nào, chạy
trong `slp-room/plugin`:

```bash
npm run watch:replay -- --ask ../evals/results/<label>
```

## 12. Lỗi thường gặp

| Thông báo | Cách xử lý |
|---|---|
| `may only be created in the hq-seatwork project` | Mở HQ trong project `hq-seatwork` |
| `holds only hq seats` | Vai này phải mở trong project của nó |
| `is not a registered SLP project` | Nhờ HQ setup project trước |
| `lists for … only …` | Dùng model có trong bảng, hoặc sửa `.slp/room.json` |
| `which the room has not enabled` | Sửa `.slp/room.json`, hoặc nhờ HQ ghi lại bảng của project: HQ sẽ dựng seat đó |
| `no room is set up on this daemon` | Mở Settings, Plugins, Seatwork rồi bấm Init |
| `room seat is still open … archive them first` | Lưu trữ các agent của room, rồi gỡ room |
| `its runtime could not be built` | Sửa thứ thông báo nêu ra (thường là `~/.codex/config.toml`), rồi tạo lại agent |
| `is too old: the room needs 0.11.2 or later` | Cập nhật Paseo, chạy `paseo daemon restart`, rồi cài lại |
| Agent báo chưa đăng nhập | Chạy `claude auth login` |
| Agent không biết quy trình mới | Mở agent mới |

Xem nhật ký của plugin:

```bash
paseo plugin logs slp-seat
```
