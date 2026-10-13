# Hướng dẫn dùng seatwork

English: [GUIDE.en.md](GUIDE.en.md)

Seatwork là một plugin của Paseo, cho nhiều agent lập trình làm việc như
một đội, gọi là **room**. Bạn giao việc cho một agent. Nó chia việc, giao
từng phần, kiểm tra kết quả rồi báo lại cho bạn.

## 1. Room

```text
Bạn ── việc hằng ngày ──▶ Supervisor     mỗi project một cái
 │                            │
 │                          Lead         mỗi luồng việc một cái
 │                          ├─ Peer      mỗi việc một cái
 │                          └─ Lens      mỗi câu hỏi khó một cái
 │
 └── quản lý ───────────▶ HQ             một cái cho mọi project
```

| Vai | Việc của nó | Viết code |
|---|---|---|
| **Supervisor** | Nhận yêu cầu của bạn, chia thành các luồng việc, mở một Lead cho mỗi luồng, báo cáo cho bạn. | Không |
| **Lead** | Lo một luồng việc: lập kế hoạch, viết brief cho Peer làm từng việc, nhận hoặc trả lại kết quả. | Chỉ việc rất nhỏ |
| **Peer** | Làm một việc, trong đúng các file mà brief nêu. | Có |
| **Lens** | Trả lời một câu hỏi khó hoặc review, mà không thấy ý kiến của Lead. | Không |
| **HQ** | Đưa project vào room và chuyển lệnh của bạn xuống. | Không |

- **Seat** là một vai chạy trên một agent CLI, tên có dạng
  `<harness>-<role>`: `claude-lead`, `codex-peer`. Cả bốn CLI (`claude`,
  `codex`, `pi`, `opencode`) đều giữ được mọi vai.
- **Owner** của một seat là người nó báo cáo lên. Owner của Supervisor là
  bạn.

Ba quy tắc:

- Việc hằng ngày: nói với Supervisor của project.
- HQ chỉ để quản lý: tình hình mọi project, thêm project mới, gửi một lệnh
  xuống.
- Không có gì tự đi lên HQ. Nó chỉ xem khi bạn bảo.

## 2. Cài đặt

Bạn cần:

- Paseo 0.11.2 trở lên, trên macOS hoặc Linux, đang bật bộ công cụ dành
  cho agent (mặc định là bật).
- Ít nhất một trong Claude Code, Codex, Pi (0.99 trở lên) và OpenCode, đã
  đăng nhập. Lựa chọn có sẵn dùng Claude Code và Codex.

1. Trong Paseo mở **Settings → Plugins**, dán dòng này vào **Plugin
   source** rồi bấm **Install plugin**:

   ```
   git:sting9k/seatwork:plugin
   ```

2. Bấm **Seatwork** ở đầu sidebar. Đổi model cho từng vai, hoặc để nguyên
   lựa chọn có sẵn (mục 6).
3. Bấm **Init**.

Init tạo thư mục của room `~/.config/seatwork`, các seat và bốn profile
trong Paseo (**HQ Supervisor**, **Supervisor**, **Lead**, **Peer**), và
project `hq-seatwork`, nơi HQ làm việc. Không cần khởi động lại gì.

Seat dùng phiên đăng nhập của agent CLI trong terminal của bạn. Seatwork
không lưu token nào. Với Claude, `claude auth login` là đủ cho mọi vai.

### Cài từ terminal

`install.sh` thay cho ba bước trên. Dùng nó trên máy không có app, hoặc khi
bạn sửa chính các file của room. Cần có `node`, `npm` và `paseo`.

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork && ./install.sh
```

Lần đầu nó hỏi HQ chạy trên gì và có bật watcher không. Dùng cờ để trả lời
sẵn:

| Cờ | Ý nghĩa |
|---|---|
| `--hq default` | HQ dùng lựa chọn có sẵn của room |
| `--hq <harness>/<model>` | HQ dùng model đó; thêm `--hq-thinking <mức>` nếu cần |
| `--watcher off\|shadow\|on` | Chế độ của watcher (mục 8) |
| `--seat <harness>-<role>` | Dựng thêm một seat; dùng được nhiều lần |
| `--mail-port <cổng>` | Cổng của máy chủ thư, khi cổng mặc định đã có chương trình khác dùng |

Ba điều cần biết:

- Script và Init thay cho nhau, không dùng cả hai. Gặp plugin đã cài từ
  Settings thì script từ chối và không đổi gì. Chạy
  `paseo plugin remove seatwork` trước; thư mục của room, thư và các lựa
  chọn được giữ nguyên.
- Script còn tắt Dictation và Voice mode của Paseo, và bật bộ công cụ dành
  cho agent. Nếu nó kết thúc bằng dòng Paseo báo có thay đổi cần restart
  thì chạy `paseo daemon restart`.
- Room cài theo cách này vẫn hiện trên màn hình Seatwork và đổi ở đó được.

## 3. Project đầu tiên

Mỗi project làm một lần, qua HQ:

1. Thêm thư mục project vào Paseo.
2. Trong project `hq-seatwork`, mở một agent bằng profile **HQ Supervisor**
   rồi viết "set up project X".
3. HQ đưa bản nháp **mission**: project để làm gì, thế nào là xong. Đồng ý
   hoặc sửa lại.
4. HQ hỏi project dùng model của room hay model riêng (mục 6). Sau đó nó
   đăng ký project và mở Supervisor của project để viết **law**: quy tắc
   riêng của project.
5. Viết cho HQ lần nữa ("tình hình thế nào"). Nó chuyển cho bạn những câu
   Supervisor không tự trả lời được từ repository, mỗi câu kèm đề xuất. Trả
   lời, hoặc nói "theo đề xuất hết". Viết thêm một lần để nghe HQ báo
   project đã sẵn sàng.

HQ chỉ xem khi bạn viết. Khi đã có project được đăng ký, Supervisor, Lead,
Peer và Lens chỉ khởi động được bên trong project đã đăng ký.

Room giữ file của nó cho một project trong `.seatwork/`. Ngoài phần việc
bạn giao, nó không ghi gì khác vào project.

```text
.seatwork/
├── room.json        đánh dấu project; giữ bảng model riêng, nếu có
├── mission.md       project để làm gì
├── <tên>-law.md     quy tắc riêng của project
├── status.md        yêu cầu, quyết định, phản đối bị bác, tiến độ
├── notebook.md      bài học rút ra
├── plans/           kế hoạch của Lead cho việc rủi ro hoặc dài
└── reviews/         báo cáo của một lần review sâu do Lead chạy
```

## 4. Việc hằng ngày

Mở một agent bằng profile **Supervisor** trong project rồi nói việc cần
làm. Một yêu cầu đầy đủ có ba phần; thiếu phần nào Supervisor sẽ hỏi.

| Phần | Ví dụ |
|---|---|
| Kết quả | "Thêm lệnh `notes search <từ>`" |
| Cách nghiệm thu | "Có test; `python3 -m unittest` chạy qua" |
| Quyền hạn | "Được commit, không push" |

Sau đó room tự làm:

1. Supervisor chia việc thành các luồng việc, mỗi luồng một Lead.
2. Lead viết brief cho từng việc và mở một Peer làm việc đó.
3. Lead xem xét từng kết quả, cho một Peer thuộc họ model khác review, rồi
   nhận hoặc trả lại.
4. Khi mọi việc đã được nhận, Lead chạy các phép kiểm tra nghiệm thu trên
   toàn bộ kết quả, rồi Supervisor báo cáo cho bạn.

Việc rủi ro cao (đăng nhập và phân quyền, mất dữ liệu, tiền, migration)
phải có kế hoạch viết ra trước khi viết code, và được review kỹ hơn ở cuối.

Lúc nào muốn thì hỏi "tình hình thế nào". Muốn đổi hướng thì nói với
Supervisor. Nếu bạn viết thẳng cho một Peer thì nó làm theo, và mở đầu báo
cáo kế tiếp bằng `DIRECT:` để Lead biết.

### Báo cáo

Dòng đầu cho biết trạng thái:

| Dòng đầu | Ý nghĩa |
|---|---|
| `DONE` | Mọi thứ đã được nhận, không còn gì đang chạy |
| `STATUS` | Đang làm |
| `DECISION_NEEDED` | Bạn phải quyết định một việc |
| `BLOCKED` | Bị kẹt, không làm tiếp được |

Bên dưới:

- **Evidence (Lead `<luồng việc>`)**: các phép kiểm tra Lead đã chạy, kèm
  mấy dòng cuối của kết quả. Supervisor không tự chạy phép nào.
- **Decided by the room**: những gì các agent tự quyết, và bạn có được xem
  lại hay không.
- **Overruled**: một phản đối không được làm theo, kèm bằng chứng của nó.
- Các dòng cuối cho biết việc tiếp theo: `DONE: …`, `WAITING ON YOU: …`,
  hoặc `WORKING` với một dòng cho mỗi Lead.

Agent không quyết thay bạn những việc này mà sẽ hỏi: chi phí, phạm vi sản
phẩm, việc không hoàn tác được, và hành động ra bên ngoài như push, merge,
deploy.

### Khi nào cần tới bạn

- **Âm báo.** Khi app đang mở, nó phát một tiếng ngắn mỗi khi HQ, một
  Supervisor hoặc seat do bạn mở kết thúc lượt với `DECISION_NEEDED`,
  `BLOCKED`, dòng `WAITING ON YOU:`, hoặc một lỗi.
- **Dòng Room** ở cuối sidebar đếm số lượt đang chờ bạn. Bấm vào là mở màn
  hình của cả room: các lượt đó, rồi HQ và từng project với các seat của
  nó. Bấm một seat để mở nó.

## 5. HQ

| Bạn muốn | Viết cho HQ |
|---|---|
| Tình hình mọi project | "các project thế nào rồi" |
| Thêm project | "set up project X" |
| Gửi một lệnh xuống | "project X: dừng Y", "làm Z trước" |
| Room làm gì gần đây | "thống kê room 7 ngày qua" |
| Watcher thấy gì, tốn bao nhiêu | "thống kê watcher" |

HQ chỉ tạo Supervisor, không tạo vai nào khác. Supervisor không biết một
lệnh đến từ HQ.

## 6. Model

### Bảng có sẵn

Đó là cách cài của một người, không phải khuyến nghị.

| Vai | Tên | Model | Lead chọn nó cho |
|---|---|---|---|
| HQ, Supervisor, Lead | | `claude-opus-5-5`, high | |
| Peer | `cheap` | `claude-haiku-5-5` | Việc máy móc, đã tả rõ hết: đổi tên, định dạng, đọc log, sửa tài liệu |
| Peer | `default` | `claude-sonnet-5-5` | Viết code, gỡ lỗi, nghiên cứu |
| Peer | `cross-family` | `gpt-6.1-sol` (Codex) | Review cái một Peer Claude viết; phân xử; thử lại |
| Lens | `default` | `gpt-6.1-sol` (Codex) | Một lens: ý kiến thứ hai về một kế hoạch hay một lỗi |
| Lens | `high` | `gpt-6-astra` (Codex) | Lens duy nhất khi câu hỏi khó; một trong hai lens |
| Lens | `extra` | `claude-opus-5-5` | Lens còn lại trong hai, thuộc họ model khác; lens thứ ba |

`claude-haiku-5-5` cần Claude Code 2.1.293 trở lên.

- Với Peer, khi chưa chắc thì Lead bắt đầu ở model thấp hơn. Nó chỉ lên bậc
  sau khi đã thử lại với brief rõ hơn mà vẫn hỏng.
- Hai lens luôn là hai model khác nhau.
- Các quy trình của Lead gọi model của Peer bằng tên `cheap`, `default` và
  `cross-family`. Giữ ba tên đó và đổi model bên dưới. Tên khác thì thêm
  tuỳ ý.

### Đổi bảng của room

Trên màn hình Seatwork, tab **Settings**: bấm một vai, chọn agent CLI,
model và mức thinking, rồi bấm **Apply changes**.

- HQ, Supervisor và Lead mỗi vai chạy trên một model.
- Peer và Lens là một vai với nhiều model có tên. Mỗi model có một dòng
  "Use for" để Lead đọc. Đổi, xoá, hoặc bấm **Add a model**.
- Seat được dựng khi một lựa chọn cần tới nó: cho Lead chạy Codex, áp dụng,
  và `codex-lead` xuất hiện.
- **Back to the shipped table** bỏ hết lựa chọn của bạn.

HQ chạy theo bảng này, và mọi project không có model riêng cũng vậy.

### Bảng riêng của project

Tab **Projects**: bấm project, đổi một vai, bấm **Save**. Vai đó giờ là của
riêng project; các vai còn lại vẫn theo room. **Same as the room's table**
trả một vai về bảng của room. HQ cũng có thể viết bảng này khi đăng ký
project.

Lựa chọn được lưu trong chính project, ở object `models` của
`.seatwork/room.json`. Nó chỉ chứa phần khác với bảng của room, và bạn sửa
tay được:

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

Ví dụ này cho Lead và model `default` của Peer dùng thinking medium, và bỏ
`cross-family`.

- `null` là bỏ một mục. Xoá `models` là quay về bảng của room.
- Model ghi theo dạng `<harness>-<role>/<model>`. Seat mà bảng nêu nhưng
  room chưa có sẽ được dựng khi bạn bấm Save.
- Mục ghi sai làm agent của project không khởi động được. Lỗi nêu rõ mục
  nào, và màn hình đánh dấu project là "Needs you".

### Khi nào thay đổi có hiệu lực

- Thay đổi tới mọi seat mở sau khi bạn áp dụng hoặc lưu. Seat đang mở giữ
  model của nó cho tới khi được lưu trữ.
- Bạn không phải thay Supervisor hay Lead đang mở. Plugin ép mỗi seat
  chúng mở theo bảng mới.
- Peer hoặc Lens được gọi với model mà bảng không còn liệt kê thì bị từ
  chối, và Lead của nó chọn lại.

## 7. Màn hình Seatwork

Bấm **Seatwork** ở đầu sidebar. Dòng đó ghi "Set up" khi chưa có room, và
"Needs you" khi một phép kiểm tra máy này báo lỗi.

| Phần | Để làm gì |
|---|---|
| Trạng thái của room | Room có đang chạy không. Có **Init** khi chưa có room; có **Apply changes** và **Discard** khi có lựa chọn đang chờ. |
| Models | Mỗi vai chạy trên gì (mục 6) |
| Tab **Projects** | Mỗi project một dòng: **Room table** hoặc **Own**. Bấm một project để đặt model riêng. |
| Watcher | Chế độ, model key và chi phí tháng này (mục 8) |
| Chime | Âm báo khi một seat chờ bạn |
| This host | Các phép kiểm tra máy này, và các agent CLI đã sẵn sàng |
| Remove the room | Mục 10 |

Lựa chọn được lưu ngay khi bạn chọn. Room chỉ đổi khi bạn áp dụng.

**This host** cảnh báo trong các trường hợp sau:

| Kiểm tra | Cảnh báo khi |
|---|---|
| Paseo's tools for agents | Bộ công cụ đang tắt. Thiếu nó, seat không tạo được và không liên lạc được với nhau. |
| Room files | Plugin và file của room thuộc hai phiên bản khác nhau. Hãy áp dụng. |
| Pi | Có seat Pi mà máy không có Pi, hoặc Pi cũ hơn 0.99. |
| Dictation, Voice mode | Một trong hai đang bật, cho mọi agent trên máy. Tắt trong phần cài đặt của Paseo. |
| Two copies of this plugin | `slp-seat`, id của plugin trước 0.18.0, vẫn còn cài. Chạy `paseo plugin remove slp-seat`. |

## 8. Watcher

Watcher đọc mọi lượt của Lead và Peer: các lần gọi tool và tin nhắn cuối,
không bao giờ đọc phần thinking. Khi một lượt có dấu hiệu đi sai, seat phía
trên nhận một thư từ `room`, tiêu đề bắt đầu bằng `OBSERVATION`. Watcher
không bao giờ dừng hay sửa một seat.

| Chế độ | Điều xảy ra |
|---|---|
| Off | Không đọc gì |
| Shadow | Đọc các lượt và ghi phát hiện vào log; không gửi thư cho ai |
| On | Gửi thư cả phát hiện, mỗi lượt nhiều nhất một thư |

Muốn bật: cho nó chạy Shadow một thời gian, hỏi HQ thống kê watcher, rồi
đặt **Mode** thành On và áp dụng.

Mười ba luật đọc các lần gọi tool, git và brief. Chúng không tốn tiền:

| Luật | Lên tiếng khi seat |
|---|---|
| `irreversible` | chạy một lệnh không hoàn tác được từ bên trong việc đó: `git reset --hard`, xoá đệ quy ngoài phạm vi, force push |
| `outside-project` | ghi ra ngoài project |
| `outside-scope` | sửa một file ngoài phạm vi ghi mà brief cho |
| `software-install` | cài một công cụ hay tải một trình duyệt về máy mà brief không cho: `brew install`, `npm install -g`, `playwright install`, một file nén hay một script tải bằng `curl`. Dependency của chính project thì không tính |
| `edit-after-reopen` | đã gửi `REOPEN_REQUEST` mà vẫn sửa source |
| `unreported-test-change` | gửi `CANDIDATE` có sửa test đã có từ trước mà không nêu tên các test đó |
| `review-without-check` | đưa ra `REVIEW` chấp nhận trong khi không chạy phép kiểm tra nào |
| `same-failure` | chạy cùng một phép kiểm tra 4 lần với cùng một lỗi |
| `repeating` | làm cùng một việc 4 lần liền với cùng kết quả |
| `shell-wait` | ngồi chờ trong shell một phút (`sleep`, vòng lặp có sleep) |
| `silent` | ở trong lượt mà không hoạt động gì, quá thời gian cho phép của vai |
| `incomplete-brief` | là Peer nhận brief thiếu `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` hoặc dòng cuối `Reply with seatwork_mail to: owner` |
| `skill-skipped` | là Peer viết code, gửi `CANDIDATE` mà chưa nạp `candidate-handoff`, hoặc sửa code dưới một luật dự án có nêu skill của nó mà chưa nạp skill đó. Chỉ ghi log, cho tới khi bạn đặt thành `raise` |

Ba luật cần một model quyết định để đọc tin nhắn cuối của seat. Luật đầu
tiên có gửi thư. Hai luật còn lại chỉ ghi log cho tới khi bạn đặt chúng
thành `raise` trong `policy.json`.

| Luật | Hỏi khi |
|---|---|
| `unverified-completion` | tin nhắn nói về kiểm tra, mà không có test nào đứng sau thay đổi cuối |
| `external-action` | seat đã push, publish hoặc deploy, và brief có ràng buộc |
| `reopen-condition` | brief có dòng `Reopen when` mà seat không xin mở lại |

Ba luật này cần một key. Không có key thì mười ba luật kia vẫn chạy, và không
có gì rời khỏi máy.

- Model là Jev, gọi qua OpenRouter. Dán key vào ô **Model key** trên màn
  hình Seatwork, hoặc đặt biến `SEATWORK_WATCH_KEY`. Key được lưu ở
  `~/.config/seatwork/watch/key`, chỉ user của bạn đọc được, và không bao
  giờ hiện lại.
- Những gì được gửi đi: các dòng của brief mà câu hỏi cần đọc, tên các file
  đã đổi, và tin nhắn cuối của seat sau khi che các bí mật. Output của tool
  không bao giờ được gửi.
- Kế hoạch là 6 USD một tháng, tới 10 USD thì ngừng hỏi. Mục Usage của
  Paseo hiện chi phí ở dòng "Room watcher".

## 9. Cách room giữ kỷ luật

### Thư

Các seat nói chuyện bằng thư. Thư không cắt ngang ai: nó tới khi lượt của
người nhận kết thúc. Kết quả đã xong chỉ đi lên một lần, khi lượt của chính
người gửi đã kết thúc. Seat đang đóng vẫn nhận được thư, vì thư mở nó ra.
Thư gửi cho seat đã lưu trữ quay về người gửi với nhãn `UNDELIVERABLE`.

Các tín hiệu bạn sẽ thấy trong báo cáo:

| Tín hiệu | Ai gửi | Ý nghĩa |
|---|---|---|
| `CANDIDATE` | Peer | Có kết quả chờ kiểm tra |
| `QUESTION` | Peer | Brief thiếu thông tin |
| `REOPEN_REQUEST` | Peer | Brief sai ở đâu đó, kèm bằng chứng Peer đã chạy |
| `DEPENDENCY_REQUEST` | Peer | Cần một thứ nằm ngoài phạm vi của nó |
| `REVIEW` | Peer, Lens | Một bản review hoặc câu trả lời, có quan điểm rõ |
| `ACCEPT` / `REJECT` | Lead | Nhận, hoặc trả lại kèm chỗ cần sửa |
| `REVISED BRIEF` | Lead | Peer đúng; brief đã đổi |
| `HOLD` / `NOTED` | Lead | Giữ hướng cũ; phản đối đã được ghi lại |

Plugin kiểm tra ai được tạo ai và ai được gửi thư cho ai:

| Seat | Được tạo | Được gửi thư cho |
|---|---|---|
| HQ | Supervisor | Supervisor |
| Supervisor | Lead, một Peer nghiên cứu | Lead, Peer |
| Lead | Peer, Lens | Supervisor, Peer, Lens |
| Peer | không ai | Lead, Supervisor |
| Lens | không ai | Lead |

Thư ngoài bảng này bị từ chối. Seat được tạo ngoài bảng này bị lưu trữ, và
người tạo được báo.

### Seat được cấp những gì

Seat nhận prompt và skill của vai mình, mission và law của project, công
cụ gửi thư, và những công cụ Paseo mà vai đó được dùng. Nó không mang
thiết lập agent cá nhân của bạn:

- **Seat Claude** dùng phiên đăng nhập của bạn, nhưng tắt thiết lập cá
  nhân: không có skill, plugin, hook hay MCP server riêng của bạn, và không
  có các tính năng thêm của Claude Code như memory, agent teams, workflows
  và connector của claude.ai. File `~/.claude/CLAUDE.md` của bạn vẫn được
  nối vào prompt.
- **Seat Codex, Pi và OpenCode** mỗi cái có một thư mục nhà riêng dưới
  `~/.config/seatwork/runtimes/`: có phiên đăng nhập của bạn, không có
  plugin, MCP server, hook và memory.
- Sub-agent riêng của từng CLI bị tắt. Seat chỉ có thêm người bằng cách tạo
  một seat khác.

Hai giới hạn:

- **Các quy tắc chỉ chặn nhầm lẫn. Chúng không phải ranh giới bảo mật.**
  Mọi seat chạy dưới tài khoản của bạn, với file của bạn. Lens được dặn chỉ
  đọc, nhưng một lệnh shell vẫn ghi được.
- **Init đổi ba công tắc của mọi agent trên máy**, không riêng gì seat:
  tắt công cụ trình duyệt của Paseo, tắt terminal agent hooks, và không
  nạp các skill đi kèm Paseo vào agent. Nó cũng bật công tắc cấp công cụ
  Paseo cho agent.

## 10. Bảo trì

### Cập nhật

```bash
paseo plugin update seatwork
```

Sau đó bấm **Apply** trên màn hình Seatwork. Chưa bấm thì room từ chối seat
mới. Room dựng từ bản clone thì cập nhật ngay trong bản clone: `git pull`,
rồi `./install.sh`.

### Tự dọn dẹp

| Thứ gì | Khi nào bị dọn |
|---|---|
| Lens đang rảnh | Sau 12 giờ |
| Lead hoặc Peer đang rảnh | Sau 48 giờ |
| Supervisor đang rảnh | Sau 7 ngày |
| HQ | Không bao giờ |
| Các dòng của log thư và log dọn dẹp | Sau 7 ngày |
| Bản sao room tạo cho `config.json` của Paseo | Sau 7 ngày; bản mới nhất luôn được giữ |
| Thư mục do Remove hoặc Init để sang một bên | Sau 30 ngày |

- Seat rảnh được lưu trữ, không bị xoá. Seat đang chờ cấp quyền hoặc chờ
  trả lời, hoặc còn seat đang mở bên dưới, thì được để yên.
- Thư cũ hơn 7 ngày không trả lời bằng id được nữa, và thống kê room nhìn
  được tối đa 7 ngày.
- Được giữ nguyên: `registry-log.jsonl`, log quét của watcher, và các dòng
  ACCEPT, REJECT, REVISED BRIEF trong log thư. Thống kê của watcher được
  tính từ chúng.
- Việc dọn chỉ chạy khi plugin còn được cài. Nếu bạn gỡ plugin thì tự xoá
  `~/.config/seatwork.removed-<thời điểm>`.

### Remove the room

Đường link dưới cột bên phải của màn hình Seatwork. Nó từ chối khi còn seat
của room đang mở: lưu trữ các agent đó trước. Sau đó nó:

- gỡ các seat, các profile và project `hq-seatwork` khỏi Paseo;
- chuyển thư mục của room sang `~/.config/seatwork.removed-<thời điểm>`, kể
  cả thư và log;
- chuyển các file của room ra khỏi `.seatwork/` ở mọi project nó từng làm
  việc, vào chính thư mục đó.

Project của bạn vẫn ở trong Paseo. Trong `.seatwork/`, room chỉ lấy những
tên mà mục 3 liệt kê; file của bạn ở đó được giữ lại. Hãy gỡ room trước
khi gỡ plugin: gỡ riêng plugin không hoàn tác Init.

### Từ bản trước 0.19.0

Bản 0.19.0 đổi tên mọi thứ từng mang chữ `slp`, và chuyển nguồn cài sang
`git:sting9k/seatwork:plugin`. Bản cài cũ hơn không được mang sang:

1. Gỡ plugin: `paseo plugin remove seatwork`, hoặc
   `paseo plugin remove slp-seat` với bản cài từ trước 0.18.0.
2. Cài lại (mục 2) rồi bấm **Init**.
3. Đưa lại từng project vào room qua HQ.

Init tự dọn room cũ. Thư mục của nó được chuyển sang
`~/.config/slp-room.removed-<thời điểm>`, có mission và law của từng
project dưới `projects/`. Key của watcher được mang sang.

### File và log

```text
~/.config/seatwork/
├── hq-seatwork/         thư mục làm việc của HQ
├── room/                prompt, skill và bảng model đang dùng
├── role-skills/         skill theo vai cho seat Claude
├── runtimes/            thư mục nhà của seat Codex, Pi và OpenCode
├── mail/                thư và log thư (log.jsonl)
├── watch/               watcher: key, log quét và chi phí
├── setup.json           lựa chọn của máy này
├── policy.json          các quy tắc đang dùng
├── seats.json           các seat đã dựng trên máy này
├── projects.json        các project đã đăng ký
├── registry-log.jsonl   mọi seat đã tạo từ trước tới giờ
└── gc.log               log dọn dẹp
```

Seat Claude lưu session trong `~/.claude/projects`, cạnh session của bạn.
Log của chính plugin:

```bash
paseo plugin logs seatwork
```

## 11. Lỗi

| Thông báo | Cách xử lý |
|---|---|
| `is a room seat and no room is set up on this daemon` | Mở màn hình Seatwork và bấm Init |
| `the room's files were set up by version …` | Bấm Apply trên màn hình Seatwork |
| `is not a seat the room has set up` | Chọn agent CLI đó cho vai trên màn hình Seatwork, rồi Apply |
| `may only be created in the hq-seatwork project` | Mở HQ trong project `hq-seatwork` |
| `it holds only hq seats` | Mở vai này trong project của nó |
| `is not a registered Seatwork project` | Bảo HQ đưa project vào room trước |
| `lists for … only …` | Seat được gọi với model mà bảng của nó không liệt kê. Dùng model có trong bảng, hoặc đổi bảng |
| `which the room has not enabled` | Mở project trên màn hình Seatwork rồi bấm Save, hoặc sửa `.seatwork/room.json` |
| `its runtime could not be built` | Sửa thứ mà thông báo nêu (thường là `~/.codex/config.toml`), rồi tạo lại agent |
| `still open … archive them first` | Lưu trữ các agent của room, rồi gỡ room |
| `is too old: the room needs 0.11.2 or later` | Cập nhật Paseo, chạy `paseo daemon restart`, rồi cài lại |
| `already runs from …, not from this clone` | `install.sh` gặp plugin cài từ nơi khác. Chạy lệnh `paseo plugin remove` mà thông báo đưa ra, rồi chạy lại script |
| Agent báo chưa đăng nhập | Đăng nhập agent CLI đó trong terminal |
| Agent không biết một quy trình mới | Mở agent mới: seat nhận prompt lúc nó được tạo |
