# Hướng dẫn dùng seatwork

English: [GUIDE.en.md](GUIDE.en.md)

Seatwork là một plugin của Paseo. Nó cho nhiều agent lập trình làm việc như
một đội, tài liệu này gọi là **room**. Bạn giao việc cho một agent. Nó chia
việc, giao từng phần cho agent khác, kiểm tra kết quả rồi báo lại cho bạn.

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
| **Supervisor** | Người làm việc với bạn trong một project. Ghi lại điều bạn yêu cầu, chia thành các luồng việc, mở một Lead cho mỗi luồng, báo cáo cho bạn. | Không |
| **Lead** | Lo một luồng việc. Lập kế hoạch, viết brief cho từng việc, giao cho Peer, nhận hoặc trả lại kết quả. | Chỉ việc rất nhỏ |
| **Peer** | Làm một việc, trong đúng các file mà brief nêu. | Có |
| **Lens** | Trả lời một câu hỏi khó cho Lead, hoặc review, mà không được thấy ý kiến riêng của Lead. | Không, chỉ đọc |
| **HQ** | Nhìn mọi project. Đưa project vào room và chuyển lệnh của bạn xuống Supervisor. | Không |

Hai từ dùng bên dưới:

- **Seat** là một vai chạy trên một agent CLI, tên có dạng
  `<harness>-<role>`: `claude-lead`, `codex-peer`. "Harness" là từ trong
  code chỉ agent CLI: `claude`, `codex`, `pi` hoặc `opencode`. Cả bốn đều
  giữ được mọi vai.
- **Owner** là người mà một seat báo cáo lên. Với Supervisor thì đó là
  bạn.

Ba quy tắc:

- **Việc hằng ngày: nói với Supervisor của project.**
- **HQ chỉ để quản lý:** tình hình mọi project, thêm project mới, gửi một
  lệnh xuống.
- **Không có gì tự đi lên HQ.** Các seat trong project không biết có HQ.
  HQ chỉ xem khi bạn bảo.

## 2. Cài đặt

Bạn cần:

- Paseo 0.11.2 trở lên, trên macOS hoặc Linux.
- Ít nhất một trong Claude Code, Codex, Pi (0.99 trở lên) và OpenCode, đã
  đăng nhập. Lựa chọn có sẵn dùng Claude Code và Codex.
- Bộ công cụ Paseo dành cho agent đang bật. Đây là mặc định của Paseo.

### Bước 1: cài plugin

Trong Paseo mở **Settings → Plugins**. Dán dòng này vào **Plugin source**
rồi bấm **Install plugin**:

```
git:sting9k/seatwork:slp-room/plugin
```

Bước này chỉ tải plugin về. Chưa có thư mục, seat hay project nào được
tạo.

### Bước 2: chọn mỗi vai chạy trên gì

Trong menu **…** của plugin, chọn **Seatwork**. Màn hình liệt kê năm vai,
mỗi vai kèm lựa chọn có sẵn. Đổi cái bạn muốn, hoặc để nguyên. Mục 3 giải
thích từng phần của màn hình.

### Bước 3: bấm Init

Init tạo ra:

- thư mục của room, `~/.config/slp-room`;
- các seat trong Paseo, mỗi seat là một provider;
- bốn profile: **HQ Supervisor**, **Supervisor**, **Lead**, **Peer**;
- project `hq-seatwork`, nơi HQ làm việc.

Không cần khởi động lại gì.

### Đăng nhập

Seat dùng phiên đăng nhập của agent CLI trong terminal của bạn. Seatwork
không lưu token nào. Với Claude, đăng nhập một lần là đủ cho mọi vai:

```bash
claude auth login
```

### Cài từ terminal

Dùng cách này trên máy không có app, hoặc khi bạn sửa chính các file của
room. Cần có `node`, `npm` và `paseo`.

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

Nó làm đúng việc của Init và chạy lại bao nhiêu lần cũng được. Lần đầu nó
hỏi hai câu: HQ chạy trên gì, và có bật watcher không. Dùng cờ để trả lời
sẵn:

| Cờ | Ý nghĩa |
|---|---|
| `--hq default` | HQ dùng lựa chọn có sẵn của room |
| `--hq <harness>/<model>` | HQ dùng model đó; thêm `--hq-thinking <mức>` nếu cần |
| `--watcher off\|shadow\|on` | Chế độ của watcher (mục 10) |
| `--seat <harness>-<role>` | Dựng thêm một seat; dùng được nhiều lần |
| `--mail-port <cổng>` | Cổng của máy chủ thư, khi cổng mặc định đã có chương trình khác dùng |
| `--seats-only` | Chỉ dựng seat; giữ nguyên file của room và plugin |

Room cài theo cách này vẫn hiện trên màn hình thiết lập, với đúng các lựa
chọn nó đang chạy.

## 3. Màn hình thiết lập

**Settings → Plugins → … → Seatwork**. Command Center cũng có mục này, tên
là "Seatwork: set up the room".

Lựa chọn được lưu ngay khi bạn chọn. Room chỉ đổi khi bạn bấm **Init** (lần
đầu) hoặc **Apply** (các lần sau). Khi hai bên còn khác nhau, dòng trên
cùng ghi "changes not applied".

### What each role runs on

Mỗi vai một dòng. Bấm vào dòng để mở.

- **HQ, Supervisor, Lead** mỗi vai chạy một model. Chọn agent CLI, model
  và mức thinking. Danh sách model có ô tìm kiếm. Danh sách chỉ hiện những
  gì máy này có; CLI nào chưa sẵn sàng thì được ghi rõ, kèm lý do.
- **Peer và Lens** mỗi vai là một, nhưng có nhiều model. Mỗi model có một
  tên (`cheap`, `default`, `high`…) và một dòng nói nó dùng cho việc gì.
  Lead đọc tên và dòng đó rồi tự chọn cho từng việc. Bạn có thể đổi một
  model, bấm **Remove** để bỏ nó, hoặc thêm model ở **One more model**: đặt
  tên (chữ thường, số, gạch ngang) và ghi dòng "Use for".
- **Reset** bỏ hết lựa chọn của bạn, quay về bảng có sẵn của room.

Seat được dựng khi một lựa chọn cần tới nó. Cho Lead chạy Codex rồi bấm
Apply là có `codex-lead`.

### Watcher and sound

- **Watcher**: Off, Shadow hoặc On. Xem mục 10.
- **Watcher key**: hiện ra sau khi Init. Không bắt buộc.
- **Chime**: một tiếng báo ngắn trong app đang mở, khi có seat chờ bạn.

### This host

Các phép kiểm tra máy này. Mỗi dòng ghi **OK**, **Needs you** hoặc
**Unknown**.

| Kiểm tra | Ghi "Needs you" khi |
|---|---|
| Paseo's tools for agents | Bộ công cụ đang tắt. Thiếu nó, seat không tạo được và không liên lạc được với nhau. |
| Room files | Plugin và file của room thuộc hai phiên bản khác nhau. Bấm Apply. |
| Pi | Có seat Pi mà máy không có Pi, hoặc Pi cũ hơn 0.99. |
| Dictation, Voice mode | Một trong hai đang bật. Nó bật cho mọi agent trên máy; tắt trong phần cài đặt của Paseo. |

### Remove the room

Bấm hai lần. Nó từ chối khi còn seat của room đang mở: hãy lưu trữ các
agent đó trước. Sau đó nó:

- gỡ các seat và profile khỏi Paseo;
- lưu trữ workspace `hq-seatwork`;
- chuyển thư mục của room sang `~/.config/slp-room.removed-<thời điểm>`,
  giữ nguyên thư và log.

Project `hq-seatwork` (đã trống) vẫn nằm trong danh sách của Paseo; muốn bỏ
thì xoá ở đó. Chỉ gỡ plugin thì không hoàn tác được Init, nên hãy gỡ room
trước.

## 4. Project đầu tiên

Mỗi project làm một lần, qua HQ.

1. Thêm thư mục project vào Paseo.
2. Trong project `hq-seatwork`, mở một agent bằng profile **HQ
   Supervisor**. HQ chỉ khởi động được ở đó.
3. Viết: "set up project X".
4. HQ đọc README rồi đưa bạn bản nháp **mission**: project để làm gì, thế
   nào là xong. Đồng ý hoặc sửa lại.
5. HQ hỏi một câu: project dùng bảng model của room, hay bảng riêng (mục
   7)?
6. HQ đăng ký project và mở Supervisor của nó để viết **law**: quy tắc
   riêng của project, ví dụ review thế nào, việc gì phải hỏi bạn trước.
7. Viết cho HQ lần nữa ("tình hình thế nào"). Nó chuyển cho bạn những câu
   Supervisor không tự trả lời được từ repository, mỗi câu kèm đề xuất.
   Trả lời từng câu, hoặc nói "theo đề xuất hết".
8. Viết thêm một lần để nghe HQ báo project đã sẵn sàng.

HQ chỉ xem khi bạn viết, vì không có gì tự báo lên nó.

Sau khi project đầu tiên được đăng ký, Supervisor, Lead, Peer và Lens chỉ
khởi động được bên trong project đã đăng ký.

Project giờ có thư mục `.slp/`:

```text
.slp/
├── room.json        đánh dấu project; giữ bảng model riêng, nếu có
├── mission.md       project để làm gì
├── <tên>-law.md     quy tắc riêng của project
├── status.md        yêu cầu, quyết định, phản đối bị bác, tiến độ
└── notebook.md      bài học rút ra
```

## 5. Việc hằng ngày

Mở một agent bằng profile **Supervisor** trong workspace của project rồi
nói việc cần làm. Một yêu cầu đầy đủ có ba phần:

| Phần | Ví dụ |
|---|---|
| Kết quả | "Thêm lệnh `notes search <từ>`" |
| Cách nghiệm thu | "Có test; `python3 -m unittest` chạy qua" |
| Quyền hạn | "Được commit, không push" |

Thiếu phần nào Supervisor sẽ hỏi. Sau đó room tự làm:

1. Supervisor chia việc thành các luồng việc và mở một Lead cho mỗi luồng.
2. Lead chia luồng việc thành từng việc, viết brief cho mỗi việc và mở một
   Peer làm việc đó.
3. Peer nộp kết quả. Lead xem xét, cho một Peer thuộc họ model khác
   review, rồi nhận hoặc trả lại kèm chỗ cần sửa.
4. Khi mọi việc đã được nhận, Lead chạy các phép kiểm tra nghiệm thu một
   lần, trên toàn bộ kết quả gộp lại.
5. Supervisor báo cáo cho bạn ngay trong cuộc chat đó.

Supervisor cũng xếp cỡ cho yêu cầu: tiny, normal hoặc high-risk. Việc
high-risk (đăng nhập và phân quyền, mất dữ liệu, tiền, migration) phải có
kế hoạch viết ra trước khi viết code, và được review kỹ hơn ở cuối.

Bạn không cần ngồi theo dõi. Lúc nào muốn thì hỏi "tình hình thế nào".

### Đọc báo cáo

Dòng đầu cho biết trạng thái:

| Dòng đầu | Ý nghĩa |
|---|---|
| `DONE` | Mọi thứ đã được nhận, không còn gì đang chạy |
| `STATUS` | Đang làm |
| `DECISION_NEEDED` | Bạn phải quyết định một việc |
| `BLOCKED` | Bị kẹt, không làm tiếp được |

Ba phần giúp bạn giữ quyền kiểm soát:

- **Evidence (Lead `<luồng việc>`)**: từng phép kiểm tra Lead đã chạy, kèm
  mấy dòng cuối của kết quả. Supervisor không tự chạy kiểm tra; nó chuyển
  lên kết quả của Lead, ghi rõ tên Lead.
- **Decided by the room**: những gì các agent tự quyết, và bạn có được xem
  lại hay không.
- **Overruled**: phản đối của một agent mà không được làm theo, kèm bằng
  chứng của nó.

Các dòng cuối cho biết việc tiếp theo: `DONE: …`, `WAITING ON YOU: …`,
hoặc `WORKING` với một dòng cho mỗi Lead.

Agent không bao giờ quyết thay bạn những việc này: chi phí, phạm vi sản
phẩm, việc không hoàn tác được, và hành động ra bên ngoài như push, merge,
deploy. Chúng sẽ hỏi.

### Biết khi nào cần tới bạn

- **Âm báo.** Khi app Paseo đang mở, nó phát một tiếng ngắn mỗi khi HQ,
  một Supervisor hoặc seat do chính bạn mở kết thúc lượt với
  `DECISION_NEEDED`, `BLOCKED`, dòng `WAITING ON YOU:`, hoặc một lỗi.
- **Dòng Room** ở cuối sidebar của Paseo đếm số lượt còn đang chờ bạn. Bấm
  vào là mở màn hình của cả room: các lượt đó nằm trên cùng, rồi tới một
  dòng cho HQ và mỗi project có seat đang mở, mỗi seat một chấm (xanh khi
  đang làm). Bấm một project để xem các seat của nó theo dạng cây; bấm một
  seat để mở nó. Một lượt nằm trong danh sách cho tới khi seat đó làm việc
  lại hoặc được lưu trữ.

### Điều chỉnh giữa chừng

Nói với Supervisor. Nếu bạn viết thẳng cho một Peer thì nó vẫn làm theo, và
báo cáo kế tiếp của nó mở đầu bằng `DIRECT:` để Lead biết.

## 6. HQ

| Bạn muốn | Viết cho HQ |
|---|---|
| Tình hình mọi project | "các project thế nào rồi" |
| Thêm project | "set up project X" |
| Gửi một lệnh xuống | "project X: dừng Y", "làm Z trước" |
| Room làm gì gần đây | "thống kê room 14 ngày qua" |
| Watcher thấy gì, tốn bao nhiêu | "thống kê watcher" |

HQ gửi lệnh cho Supervisor dưới danh nghĩa Owner. Supervisor không biết
lệnh đến từ HQ. HQ chỉ tạo Supervisor, không tạo vai nào khác.

## 7. Model

### Bảng của room

Plugin đi kèm một bảng. Đó là cách cài của một người, không phải khuyến
nghị. Màn hình thiết lập bắt đầu từ bảng này.

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

Lead dùng bảng thế này:

- Với Peer, khi chưa chắc thì nó bắt đầu ở model thấp hơn. Nó chỉ lên bậc
  sau khi đã thử lại với brief rõ hơn mà vẫn hỏng.
- Hai lens luôn là hai model khác nhau.
- Các quy trình của Lead gọi model của Peer bằng tên `cheap`, `default` và
  `cross-family`. Giữ ba tên đó và đổi model bên dưới. Tên khác thì thêm
  tuỳ ý.

Đổi bảng trên màn hình thiết lập rồi bấm Apply.

### Bảng riêng của project

HQ viết bảng này khi đăng ký project. Sau đó bạn sửa tay object `models`
trong `.slp/room.json`. Chỉ ghi phần khác với bảng của room:

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
- Thay đổi áp dụng cho agent tạo sau đó. Không cần cài lại.
- Agent chạy model không có trong bảng sẽ bị từ chối.
- Mục ghi sai làm agent không khởi động được; lỗi nêu rõ mục nào.
- Model ghi theo dạng `<harness>-<role>/<model>`. Nếu bảng nêu một seat
  room chưa có, hãy bảo HQ đăng ký lại bảng: nó sẽ dựng seat đó.

## 8. Các seat nói chuyện với nhau

Seat gửi **thư** cho nhau. Thư không cắt ngang ai: nó tới khi người nhận
làm xong lượt đang chạy. Kết quả đã xong chỉ đi lên một lần, khi lượt của
chính người gửi đã kết thúc, nên không ai hành động dựa trên một seat còn
đang làm.

- Seat đang đóng vẫn nhận được thư: thư mở nó ra. Sau khi daemon khởi động
  lại, mọi seat đều ở trạng thái này.
- Thư gửi cho seat đã lưu trữ hoặc đã xoá quay về người gửi với nhãn
  `UNDELIVERABLE`.
- Có loại thư không đánh thức ai, được đọc cùng thư kế tiếp: thư xác nhận,
  thư `DONE` chỉ lặp lại chính nó, và `STATUS` của Lead sau báo cáo đầu
  (chỉ giữ bản mới nhất).

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

Plugin kiểm tra ai được gửi thư cho ai và ai được tạo ai:

| Seat | Được tạo | Được gửi thư cho |
|---|---|---|
| HQ | Supervisor | Supervisor |
| Supervisor | Lead, một Peer nghiên cứu | Lead, Peer |
| Lead | Peer, Lens | Supervisor, Peer, Lens |
| Peer | không ai | Lead, Supervisor |
| Lens | không ai | Lead |

Thư ngoài bảng này bị từ chối. Seat được tạo ngoài bảng này bị lưu trữ và
người tạo được báo; lúc đó prompt đầu tiên của nó có thể đã kịp chạy.

## 9. Seat được cấp những gì

Seat nhận prompt và skill của vai mình, mission và law của project, công
cụ gửi thư, và những công cụ Paseo mà vai đó được dùng. Nó không mang
thiết lập agent cá nhân của bạn:

- **Seat Claude** dùng phiên đăng nhập của bạn, nhưng tắt thiết lập cá
  nhân: không có skill, plugin, hook hay MCP server riêng của bạn. Các tính
  năng thêm của Claude Code cũng tắt: memory, agent teams, agent view,
  workflows, cloud routines và connector của claude.ai. File
  `~/.claude/CLAUDE.md` của bạn vẫn được nối vào prompt.
- **Seat Codex, Pi và OpenCode** mỗi cái có một thư mục nhà riêng dưới
  `~/.config/slp-room/runtimes/`. Nó được dựng từ thư mục của bạn: giữ
  phiên đăng nhập, bỏ plugin, MCP server, hook và memory.
- Sub-agent riêng của từng CLI bị tắt trong seat. Seat chỉ có thêm người
  bằng cách tạo một seat khác.

Các công tắc này nằm ngay trong provider của seat ở cấu hình Paseo, nên
vẫn có hiệu lực cả khi plugin không chạy.

Hai giới hạn cần biết:

- **Các quy tắc chỉ chặn nhầm lẫn. Chúng không phải ranh giới bảo mật.**
  Mọi seat chạy dưới tài khoản của bạn, với file của bạn. Lens được dặn chỉ
  đọc; trên Claude các công cụ sửa file của nó bị tắt, nhưng một lệnh shell
  vẫn ghi được.
- **Init đổi ba công tắc của mọi agent trên máy**, không riêng gì seat:
  tắt công cụ trình duyệt của Paseo, tắt terminal agent hooks, và không
  nạp các skill đi kèm Paseo vào agent. Nó cũng bật công tắc cấp công cụ
  Paseo cho agent.

## 10. Watcher

Watcher đọc mọi lượt của Lead và Peer: các lần gọi tool và tin nhắn cuối,
không bao giờ đọc phần thinking. Khi một lượt có dấu hiệu đi sai, seat phía
trên nhận một thư từ `room`, tiêu đề mở đầu bằng `OBSERVATION`. Thư về
Peer tới Lead của nó, thư về Lead tới Supervisor. Watcher không bao giờ
dừng hay sửa một seat.

| Chế độ | Chuyện gì xảy ra |
|---|---|
| Off | Không đọc gì |
| Shadow | Đọc các lượt và ghi phát hiện vào log; không gửi thư cho ai |
| On | Gửi thư cả phát hiện, mỗi lượt nhiều nhất một thư |

Mười luật đọc các lần gọi tool và brief. Chúng không tốn tiền:

| Luật | Lên tiếng khi seat |
|---|---|
| `irreversible` | chạy một lệnh không hoàn tác được từ bên trong việc đó: `git reset --hard`, xoá đệ quy ngoài phạm vi, force push |
| `outside-project` | ghi ra ngoài project |
| `outside-scope` | sửa một file ngoài phạm vi ghi mà brief cho |
| `edit-after-reopen` | đã gửi `REOPEN_REQUEST` mà vẫn sửa source |
| `review-without-check` | đưa ra `REVIEW` chấp nhận trong khi không chạy phép kiểm tra nào |
| `same-failure` | chạy cùng một phép kiểm tra 4 lần với cùng một lỗi |
| `repeating` | làm cùng một việc 4 lần liền với cùng kết quả |
| `shell-wait` | ngồi chờ trong shell một phút (`sleep`, vòng lặp có sleep) |
| `silent` | ở trong lượt mà không hoạt động gì, quá thời gian cho phép của vai |
| `incomplete-brief` | là Peer nhận brief thiếu `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` hoặc dòng cuối `Reply with slp_mail to: owner` |

Bốn luật cần một bên đọc tin nhắn cuối của seat. Code quyết định khi nào
hỏi, một model quyết định đọc xem tin nhắn khẳng định gì, rồi code so hai
bên. Luật đầu tiên có gửi thư; ba luật còn lại chỉ ghi log cho tới khi bạn
đặt chúng thành `raise` trong `policy.json`.

| Luật | Hỏi khi |
|---|---|
| `unverified-completion` | tin nhắn nói về kiểm tra, mà không có test nào đứng sau thay đổi cuối |
| `external-action` | seat đã push, publish hoặc deploy, và brief có ràng buộc |
| `decided-beyond-brief` | tin nhắn báo một quyết định do seat tự đưa ra |
| `reopen-condition` | brief có dòng `Reopen when` mà seat không xin mở lại |

Bốn luật này cần một key. Model quyết định là Jev, gọi qua OpenRouter. Dán
key vào ô **Watcher key** trên màn hình thiết lập. Key được lưu ở
`~/.config/slp-room/watch/key`, chỉ user của bạn đọc được, và không bao giờ
hiện lại. Biến môi trường `SLP_WATCH_KEY` cũng dùng được. Không có key thì
mười luật ở trên vẫn chạy, và không có gì rời khỏi máy.

Những gì được gửi cho model: các dòng của brief mà câu hỏi cần đọc, tên các
file đã đổi, và tin nhắn cuối của seat sau khi che các bí mật. Output của
tool không bao giờ được gửi. Chi phí tính theo từng câu trả lời: kế hoạch
là 6 USD một tháng, tới 10 USD thì ngừng hỏi. Xem trong mục Usage của
Paseo, dòng "Room watcher".

Muốn bật: cho nó chạy Shadow một thời gian, hỏi HQ thống kê watcher, rồi
đặt Watcher thành On và bấm Apply.

## 11. Bảo trì

### Cập nhật

```bash
paseo plugin update slp-seat
```

Sau đó bấm **Apply** trên màn hình thiết lập. Chưa bấm thì room từ chối
seat mới, và lỗi nói rõ điều đó. Nếu dùng bản clone: `git pull`, rồi
`./install.sh`.

### Tự dọn dẹp

Cứ 10 phút plugin lưu trữ những seat đã rảnh quá lâu và không còn seat nào
bên dưới đang chạy. Seat đang chờ cấp quyền hoặc chờ trả lời thì được để
yên.

| Vai | Lưu trữ sau khi rảnh |
|---|---|
| HQ | Không bao giờ |
| Supervisor | 7 ngày |
| Lead, Peer | 48 giờ |
| Lens | 12 giờ |

### File nằm ở đâu

```text
~/.config/slp-room/
├── hq-seatwork/         thư mục làm việc của HQ
├── room/                prompt, skill và bảng model đang dùng
├── role-skills/         skill theo vai cho seat Claude
├── runtimes/            thư mục nhà của seat Codex, Pi và OpenCode
├── mail/                thư và log thư
├── watch/               watcher: key, log quét và chi phí
├── setup.json           lựa chọn của máy này
├── policy.json          các quy tắc đang dùng
├── seats.json           các seat đã dựng trên máy này
├── projects.json        các project đã đăng ký
├── registry-log.jsonl   mọi seat đã tạo từ trước tới giờ
└── gc.log               log dọn dẹp
```

Seat Claude lưu session trong `~/.claude/projects`, cạnh session của bạn.

### Log

```bash
paseo plugin logs slp-seat
```

Thư được ghi ở `~/.config/slp-room/mail/log.jsonl`, việc dọn dẹp ở
`~/.config/slp-room/gc.log`.

## 12. Lỗi

| Thông báo | Cách xử lý |
|---|---|
| `is a room seat and no room is set up on this daemon` | Mở màn hình thiết lập và bấm Init |
| `the room's files were set up by version …` | Bấm Apply trên màn hình thiết lập |
| `is not a seat the room has set up` | Chọn agent CLI đó cho vai trên màn hình thiết lập, rồi Apply |
| `may only be created in the hq-seatwork project` | Mở HQ trong project `hq-seatwork` |
| `it holds only hq seats` | Mở vai này trong project của nó |
| `is not a registered SLP project` | Bảo HQ đưa project vào room trước |
| `lists for … only …` | Dùng một model có trong bảng của project, hoặc sửa `.slp/room.json` |
| `which the room has not enabled` | Bảo HQ đăng ký lại bảng của project, hoặc sửa `.slp/room.json` |
| `its runtime could not be built` | Sửa thứ mà thông báo nêu (thường là `~/.codex/config.toml`), rồi tạo lại agent |
| `still open … archive them first` | Lưu trữ các agent của room, rồi gỡ room |
| `is too old: the room needs 0.11.2 or later` | Cập nhật Paseo, chạy `paseo daemon restart`, rồi cài lại |
| Agent báo chưa đăng nhập | Đăng nhập agent CLI đó trong terminal |
| Agent không biết một quy trình mới | Mở agent mới: seat nhận prompt lúc nó được tạo |
