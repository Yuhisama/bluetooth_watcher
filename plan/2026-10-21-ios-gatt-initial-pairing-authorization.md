# iOS 客戶 App 首次配對：GATT 授權、初始化時序及錯誤回覆追查與修正計畫

- 日期：2026-10-21
- 狀態：已完成擷取比對與原始碼追查；B 方案（6.3）待使用者二選一，尚未修改應用程式、編譯或部署。
- 補充更新：2026-10-21 下午，加入 nRF(2)／Android nRF／Android 客戶 App(3) 擷取、Android 重送行為、B 替代方案與 A／C 實作注意事項。
- 本計畫位置：`/home/user/bt-capture/plan/`
- 擷取根目錄：`/home/user/bt-capture/captures/`
- 預定修改的應用程式專案：`/home/user/my_develop/khi-6230-cursor/`
- 範圍：優先處理 11:47:36 這筆「底層連線成功，但客戶 App 初始化失敗」；不將先前不同的 BR 失敗混為同一根因。

## 1. 問題摘要

iOS 客戶 App 在 LE 配對、加密及 Notify 訂閱成功後，立即向 Control Point 寫入 VIN 與軟體版本查詢。BlueZ 傳給儀表程式的 D-Bus options 有完整 `device` object path，但應用層列印的裝置是空字串，並拒絕兩筆查詢。

拒絕分支僅記錄訊息、發出 signal 後正常返回，沒有向 BlueZ 回傳 D-Bus error，因此手機收到 ATT Write Response，卻收不到應有的 Common ACK、VIN 或版本資料。該筆後續 HFP、A2DP、AVRCP 均成功，LE 與 BR 在擷取期間也未見斷線；使用者仍標記客戶 App 顯示失敗。

目前最符合證據的問題鏈為：

```text
device option 是 object path，但以 QVariant::toString() 取得
    ↓
取得空字串，走「缺少 device」備援授權
    ↓
備援只認正式 active 的已 bonding 手機
    ↓
新手機雖已配對、加密，仍在 currentConnectingTarget，等待狀態輪詢提升為 active
    ↓
立即抵達的 VIN／版本查詢被拒絕，沒有進入業務處理
    ↓
拒絕後正常返回 void D-Bus 方法，BlueZ 回 ATT 寫入成功
    ↓
手機可能等待業務回覆至逾時，顯示初始化失敗
```

最後一步的手機內部判定尚未取得手機端程式或日誌，不能宣稱已完全證實；前面的拒絕與正常回覆有擷取及原始碼互相支持。

## 2. 紀錄範圍與目前狀態

### 2.1 本次核心比較

| 使用者紀錄名稱 | 擷取目錄前綴 | 已觀察結果 |
|---|---|---|
| Android／客戶APP 配對(1 | `20261021-110512` | BR-first；GATT 跑在 BR/EDR PSM 0x001F；第一輪查詢未收到回覆，約 14 秒後 App 重送才收到 ACK 與資料（見 3.3）；標記 APP 成功 |
| iOS／nrf connect(1 | `20261021-114344` | 前三次 LE 舊金鑰恢復失敗，第四次重新配對；最終 LE 與 Classic 成功；僅操作自訂 Notify，沒有送相同 Control Point 查詢 |
| iOS／客戶 APP 配對 (1 | `20261021-114736` | LE-first；VIN 與版本查詢被儀表拒絕；之後 App 未再寫入 Control Point（使用者第二次操作也沒有）；Classic 後續全部成功；兩次標記 APP 失敗 |
| iOS／nrf connect(2 | `20261021-122159` | 兩端乾淨首次配對（無 LTK miss，新 RPA `72:D6:37:A5:22:4D`）；Bonded 後 17 秒才訂閱 Notify；Control Point 寫入 0 筆；標記成功 |
| Android／nrf connect(1 | `20261021-133721` | LE 配對；僅訂閱 Notify；Control Point 寫入 0 筆 |

備註：
- nRF(1) 依使用者自訂名稱辨識，其 `meta.json` 的 App 欄位仍為「系統設定」。前面的 LTK Negative Reply 表示起始金鑰狀態與另外兩筆不是完全相同，不能當作嚴格控制變因的實驗；nRF(2) 為較乾淨的對照組。
- 所有 nRF 紀錄都沒有寫 Control Point，只能證明配對、加密與 Notify 正常，**不能證明 Control Point 授權正常**。
- iOS 客戶 App 與 nRF 的唯一關鍵差異是：配對後 0.3 秒即寫 Control Point，落在「bonded 但尚未 active」的空窗；nRF 動作時早已 active 且不寫 Control Point。

### 2.2 先前失敗與本次問題的關係

| 擷取 | 失敗特徵 | 與本計畫的關係 |
|---|---|---|
| `20261021-112025` | GATT 空裝置拒絕；BR 加密成功後 0x0E 安全性拒絕並斷線 | GATT 現象相同；BR 原因另追 |
| `20261021-112545` | GATT 查詢正常處理；第一次 BR 逾時，第二次加密後 0x0E | 證明 BR 異常不必以 GATT 拒絕為前提 |
| `20261021-112909` | GATT 空裝置拒絕；BR 沒建成；LE 最後也逾時；firstConnection 忽略斷線 | GATT 現象相同；連線失敗收尾另追 |
| `20261021-114736` | GATT 空裝置拒絕，但 LE／BR 與各 Classic Profile 維持成功 | 適合優先隔離、驗證應用層 GATT 問題 |
| `20261021-135837`（Android 客戶APP配對(3) | 手機對儀表 GATT **完全沒有操作**（無探索、無 CCCD、無 Control Point）；BR 兩段式配對；無 LE 連線 | 不同問題，本計畫修正不影響，見第 7 節 |

分析器顯示補強（已完成）：原本 `analyze.py` 對非 CCCD 的 ATT 寫入只計數、Notify 只統計數量，網頁上看不到 Control Point 查詢與 ACK。已新增 `gatt_write`、`notify` 事件（由特徵值探索封包解析 handle→UUID，並對應 Control Point／Data Source 名稱），網頁新增「GATT 寫入」區塊，Notify 分類預設不勾選。判讀方式：Notify 第一個 byte 為 `0x20` 即 Common ACK。

已知分析器呈現問題：`analyze.py` 將 HCI `0x0E` 誤標為 Unacceptable BD_ADDR。正確為 Security Reasons，Unacceptable BD_ADDR 是 `0x0F`。此外，「前面沒有本機 Disconnect 命令」不代表逾時一定由手機主動發起，不能只憑 `remote` 標籤歸責。這些屬擷取工具的獨立後續項目，不納入本次應用程式根因修正。

## 3. 已確認的擷取證據

### 3.1 iOS Control Point 寫入有裝置路徑，卻被拒絕

`20261021-114736…/dbus.log:4203–4240`：

- 第一筆資料：`03 00 00`。
- 第二筆資料：`06 00 01`。
- 兩筆均帶 `device = object path /org/bluez/hci0/dev_6A_B6_85_9A_E6_8D`。
- `link = LE`，`mtu = 517`。
- 應用程式兩次都正常回傳 `method return`，不是 D-Bus error。

同筆 `journal.log:37–44`：兩筆均出現 `Write rejected for device ""`、`GattManager: Security error for device: ""`，沒有進入正常的 ControlPoint 命令處理日誌。

同筆 `btmon.out:1075–1132`：兩筆寫入後都有 ATT Write Response。

### 3.2 首次配對時序

iOS 日誌中的順序：

| 儀表時間 | 事件 |
|---|---|
| 13:05:15.116 | Bonded 完成 |
| 13:05:15.411 | VIN 查詢被拒絕 |
| 13:05:15.978 | 版本查詢被拒絕 |
| 13:05:16.744 | `updateDevicesStatus bonded!`，程式推進 active 初始化 |
| 13:05:16.836 | 非同步設定 Trusted 的完成日誌 |
| 13:05:18.656 | HFP Service Level Connection established |
| 13:05:25.912 | A2DP／AVRCP／HFP 狀態全為 true |

Trusted 的完成時間只是初始化時序旁證。安全檢查沒有直接判斷 Trusted，真正的門檻是 active target 與 bonding／connection 狀態，不能把問題簡化為「Trusted 設得太晚」。

### 3.3 Android 與 nRF 為何沒有暴露同一條失敗路徑

- Android：第一筆控制命令到達前，已完成該手機的 active 初始化（Bonded +1.4 s 提升 active，+3.3 s 才寫入）。D-Bus 的 `link` 是 `BR/EDR`，不是 LE；命令正常進入 `processPacket()`。
  - 但第一輪查詢（`06 00 02`、`03 00 03`，+3.3 s）送出時手機**尚未訂閱 Notify**（CCCD 在 +4.3～5.4 s 才寫入），btmon 中該時段沒有任何 Notification，第一輪回覆實際上沒有送達。
  - 約 14 秒後 App **自行重送**（`06 00 00`、`03 00 01`，+17.7 s／+18.3 s），這次收到 `20 0C 74 06 00`、`20 0C 76 03 01` ACK 與資料，App 才顯示成功。
  - 整份擷取只有 4 筆 Notification，全部在第二輪之後。
- iOS 與 Android 對照：兩者第一輪都沒拿到回覆（原因不同：iOS 被儀表拒絕；Android 是自己先寫後訂閱）。**Android App 有逾時重送，iOS App 沒有**，這是兩平台結果不同的直接原因；但 iOS 第一輪被拒是儀表端缺陷，屬本計畫修正對象。
- nRF：沒有送 VIN／版本查詢，主要是較晚開啟、關閉自訂 Notify；它證明傳輸與訂閱可用，沒有驗證客戶 App 的初始化查詢。
- 兩者的通訊路徑、操作順序都不同，不能直接推論 iOS OS 的配對安全性有缺陷。

## 4. 原始碼追查

以下均為應用程式專案內相對路徑；行號為追查當下版本。

| 位置 | 現有行為 | 問題／意義 |
|---|---|---|
| `App/bluetooth/bluetooth_gatt_base.cpp:77–98` | `isSecureRequestAuthorized()` 以 `options.value("device").toString()` 取值；空時使用 `hasActivePairedConnection()` | 沒有明確解析 QDBusObjectPath；把轉型失敗當成缺少 device |
| `App/bluetooth/bluetooth_gatt_base.cpp:88–91` | 非空 device 仍要求 `checkDeviceSecurity()` 與 `isActiveDeviceAddress()` 都成立 | 只修路徑解析仍會碰到 active 尚未建立的門檻 |
| `App/bluetooth/bluetooth_gatt_base.cpp:133–162` | `WriteValue()` 拒絕後發 signal 並直接 return；例外也沒有傳回 D-Bus error | 正常的 void 方法結束會回成功，造成 ATT 與業務結果不一致 |
| `App/bluetooth/bluetooth_gatt_base.cpp:100–130` | `ReadValue()` 拒絕後回空 QByteArray | 同類問題：空資料不等於正確的授權錯誤 |
| `App/bluetooth/bluetooth_gatt_base.cpp:232–276` | `checkDeviceSecurity()` 查 Paired、Connected；沒有查 Trusted | 不能以 Trusted 本身當作已證實根因；另須注意同步 D-Bus 查詢的既有行為 |
| `App/bluetooth/bluetooth_gatt_manager.cpp:223–229` | `handleSecurityError()` 只列印並等待配對 | 沒有恢復或重送被拒絕的命令；配對其實已完成時也不會自癒 |
| `App/bluetooth/bluetooth_manager.cpp:115–117` | 每 3000 ms 呼叫 `updateDevicesStatus()` | 形成配對完成與 active 就緒之間的時間窗 |
| `App/bluetooth/bluetooth_manager.cpp:563–565` | `onDevicePaired()` 只有 log | 配對完成事件沒有立即使首次 GATT 授權就緒 |
| `App/bluetooth/bluetooth_manager.cpp:1725–1733` | UI 接受配對時，存入 `m_currentConnectingTarget` | 當下已有明確的候選手機身分，但 GATT 授權未使用它 |
| `App/bluetooth/bluetooth_manager.cpp:755–800` | 確認 bonded 後，把候選者提升為 `m_activeTarget` | 正式 active 指派依賴後續狀態處理 |
| `App/bluetooth/bluetooth_manager.cpp:1927–1942` | 兩個 GATT 使用的身分／連線 helper 都只認 `m_activeTarget` | 首次配對候選者即使已安全連線仍可能被拒絕 |

### 4.1 協定內容的確認與前述判讀補充

`App/bluetooth/ble_can_service.h:113–132` 定義三個 header byte：

| Byte | 欄位 | 說明 |
|---|---|---|
| 0 | bid | `0x03` 是 VIN，`0x06` 是 Transceiver 軟體版本 |
| 1 | length | Payload 長度 |
| 2 | seqNumber | 請求序號，不是平台或工作模式參數 |

所以 `03 00 00` 與 `06 00 01` 都是可辨識的查詢；Android 的不同第三 byte 不能解讀為不同平台模式。

正常呼叫路徑為：

```text
GattCharacteristicAdaptor::WriteValue
  → ControlPointCharacteristic::onWriteValue
  → processCommand / commandReceived
  → BleGattService::handleControlCommand
  → BleCanService::processPacket
  → Common ACK（0x20）與查詢資料
```

`ble_can_service.cpp:1021–1049` 負責送 ACK 與回覆；VIN／版本 handler 分別在 `1482`、`1519` 附近。拒絕發生在路徑起點，不能靠調整後面的 ACK 佇列解決。

### 4.2 大量 Notify 的真實內容

11:47:36 那筆 82 個 Notify，其中 5 個以 `39 0c` 開頭，77 個以 `01 0c` 開頭。

- `01 0c … ff ff 0a 01 01 …` 對應 `buildCanTimeoutError()`，是 CAN `0x512` timeout 錯誤通知。
- `bluetooth_gatt_service.cpp:624–630` 在該 CAN timeout 旗標成立且 DataSource 已訂閱時，每秒送一次。
- 它不是被丟棄的 VIN／版本查詢之 ACK，不能以「Notify 一直有資料」當成初始化成功。
- CAN timeout 是否也是手機顯示失敗的條件，仍須手機端證據；本次不擅自關閉這些錯誤通知。

## 5. 推斷與可信度

| 判斷 | 狀態 | 說明 |
|---|---|---|
| BlueZ 有提供 device，不是 options 真正缺欄位 | 已證實 | D-Bus 原始紀錄可直接確認 |
| 裝置路徑讀取方式有型別問題 | 高可信、符合程式及 log | 使用 `.toString()` 而沒有明確取 QDBusObjectPath 的 path；實機修正時仍應記錄實際 QVariant 型別以封閉證據鏈 |
| 首次配對 GATT 授權依賴較晚建立的 active 狀態 | 已確認的程式行為，時序與紀錄相符 | active 指派在後面的狀態更新；候選者在當下未納入授權 |
| Trusted 為直接拒絕條件 | 不成立 | 目前該授權程式沒有檢查 Trusted |
| 拒絕命令卻回 ATT 成功 | 已證實 | 正常 D-Bus method return、ATT Write Response 及 return 分支可互證 |
| 客戶 App 因缺 VIN／版本回覆而初始化逾時 | 高度合理，待手機端確認 | 尚無手機端的狀態機、逾時條件與錯誤 log |
| 同一修正能解決之前所有 BR 0x0E／逾時 | 未證實，不作承諾 | GATT 正常時也出現過 BR 錯誤；本次失敗時 BR 反而成功 |

## 6. 預定修改方案

### 6.1 原則

1. 修正身分解析、授權時機及錯誤回覆三者，不用「全部允許」繞過。
2. 保留 Control Point 的 `secure-write`、`encrypt-write` 及現有單手機 session 限制。
3. GATT 初始查詢不應被迫等待 Classic 音訊 Profile 全部完成。
4. 不因這次 GATT 問題重排整個 Classic／音訊狀態機或修改 UI。
5. 不暫存後偷偷重送被拒絕的命令，避免重複執行與序號語意混亂。

### 6.2 A：正確解析請求裝置

修改範圍：`bluetooth_gatt_base.cpp`，必要時補對應標頭宣告。

- 以實際 QVariant 型別辨識 QDBusObjectPath，取得其 path；對已是 QString 的輸入維持相容。
- 明確區分「device 未提供」、「device 型別／內容無效」、「device 有效」。
- 有提供但解析失敗時，不可自動當成未提供後借用其他 active 手機的授權。
- 授權與拒絕 log 使用同一個已解析結果，避免診斷仍只顯示空字串。

**注意：A 會改變所有手機的授權路徑。** 目前所有請求（含 Android）都因 `.toString()` 為空而走「缺少 device」備援，身分檢查實際上從未運作過。修正後每一筆寫入都會改走 `checkDeviceSecurity() && isActiveDeviceAddress()`。

- `isActiveDeviceAddress()`（`bluetooth_manager.cpp:1927`）會從路徑取 `dev_` 後段，再與 `address()`／`publicAddress()` 比對。已用紀錄確認：iOS 首次配對與換 RPA（`6A:B6…`、`72:D6…`）時，app 記錄的 `address()` 與 D-Bus 路徑一致；Android BR GATT 路徑為 BR 位址，與 `address()` 相同。
- 仍須回歸：同一手機的 LE 與 BR 在 BlueZ 中為兩個獨立物件時、開機自動重連、雙手機切換。
- `checkDeviceSecurity()` 的 Paired／Connected 檢查與 BlueZ `secure-write` 已保證的條件重疊，每次寫入會多兩次同步 D-Bus 查詢。本次不強制修改，僅記錄。

### 6.3 B：讓已接受、已 bonding 且已連線的首次配對候選者可執行 GATT

修改範圍：`bluetooth_manager.h/.cpp` 與 GATT 授權呼叫點。

**本節有兩個候選方案，待使用者決定：B1（原案，候選者授權）或 B2（Bonded 事件立即提升 active）。**

#### B1：GATT 授權接受首次配對候選者（原案）

採取「精確辨識請求者，允許安全的首次配對候選者」的窄範圍方案。概念上的授權來源為：

| 狀態 | 預定判斷 |
|---|---|
| 既有 active 手機 | 身分相符，已 bonding／配對，且對應 session 仍有連線時依既有政策允許 |
| 首次配對候選手機 | 必須是使用者已接受的本次候選者，device 與候選者相符，實際已 bonding／配對並連線，且沒有舊手機清理／slot 衝突，才允許 |
| 只有待接受／等待舊連線清理的候選者 | 不提前放行 |
| 其他已記憶但非本次 session 的手機／FOB | 不因 bonded 就放行 |
| 有 device 但無效或無法匹配 | 拒絕並回傳明確錯誤 |
| 真正省略 device 的呼叫 | 保守保留既有 active-session 限制；不擴大成任意候選者均可通過 |

候選者授權與正式 active／音訊就緒分開處理，不為了解決兩筆查詢而提早切換整個 active slot。實作前需核對候選者 weak_ptr、配對接受旗標、位址別名與舊手機清理條件，確保不跨 session 授權。

#### B2：Bonded 事件立即執行「提升 active」（替代案）

- 觀察：`updateDevicesStatus()` 中 `m_currentConnectingTarget` → `m_activeTarget` 的提升邏輯（`bluetooth_manager.cpp:755-800`）本來就會在 Bonded 後 0～3 秒由輪詢執行；iOS 紀錄中即 Bonded 15.116 → 提升 16.723。
- 做法：把這段提升邏輯抽成 helper，輪詢與 `onDevicePaired()`（`:563`，目前只有 log）共用；Bonded 事件到達且裝置等於 `m_currentConnectingTarget`、已接受配對時立即執行一次。
- 授權規則維持只有「active」一套，GATT 授權程式不需要新增候選者概念。
- 實作前須核對：
  - 從 signal slot 呼叫時 `resetUpdateMainParameter()`、`setTrusted()`、`saveSlotsToConfig()`、`emit activateSlotStateChanged()` 的重入安全性。
  - 提升只能執行一次，輪詢路徑需因 `m_currentConnectingTarget` 已清除而自然跳過。
  - BR-first 情境（Android）與 LE-first 情境（iOS）的 `m_pairingBearer`／`m_leClassicConnectEnabled` 判斷不受提前影響。

#### 共同邊界

理論上 ATT 寫入可能在加密完成後、Bonded 屬性通知之前到達。本次紀錄順序為 Bonded 15.116 → 第一筆寫入 15.411，未發生；B1、B2 都無法完全排除此情況，C 的正確錯誤回覆可作為兜底。

#### 方案取捨

| 方案 | 優點 | 缺點／限制 | 決定 |
|---|---|---|---|
| 只修 object path | 改動最小，身分解析正確 | `isActiveDeviceAddress()` 仍會拒絕尚未 active 的首次手機 | 必做，但不足以單獨解決 |
| B1：GATT 授權辨識安全的已接受候選者 | 不動 active／音訊狀態機 | 新增第二套授權條件（已接受、bonded、已連線、無舊 slot 衝突），須長期與 active 規則保持一致，安全面變大 | 候選 |
| B2：Bonded 事件立即執行既有提升邏輯 | 授權規則只有一套；只改變時機、不改變行為；其他依賴 active 的流程也同步提前 | 須確認 signal slot 中執行的重入安全性，以及避免重複提升 | 候選（建議） |
| 手機固定延遲幾秒再寫 | 可用來佐證時序 | 依機器負載及輪詢相位而變，不是可靠的儀表根因修正 | 不作正式解法 |
| 只依 secure flags 放行所有寫入 | 簡單 | 失去應用層單手機身分隔離 | 不採用 |

### 6.4 C：拒絕要回 D-Bus error，不可偽裝成成功

修改範圍：`bluetooth_gatt_base.cpp/.h`。

- 授權拒絕時回覆 BlueZ 支援的授權錯誤，例如 `org.bluez.Error.NotAuthorized`，而不是正常 return。
- 同步檢查 ReadValue 的授權拒絕，避免以空值代表授權失敗。
- 成功路徑仍維持一次正常回覆；錯誤路徑只能有一次錯誤回覆。
- 安全拒絕與處理例外應分開記錄；不能對所有例外都謊稱為認證問題。
- 現有程式註解指出過去 `setDelayedReply` 有崩潰經驗，不能直接恢復未確認的舊做法。
- 實作時先確認 Qt 6.8 上 adaptor 的 D-Bus context 是否可用，必要時使用 Qt 支援的原始 message 回覆機制；不把未驗證的 QDBusContext／延遲回覆方案視為已可用。
  - 依 Qt D-Bus 的分派方式，context 設在實際被呼叫的物件上；以 adaptor 匯出時即 `GattCharacteristicAdaptor` 本身，因此應由 adaptor 繼承 `QDBusContext`，在 slot 內同步 `sendErrorReply()`，不需要 `setDelayedReply`。
- **ATT 錯誤碼對手機的影響須實機確認**：BlueZ 會把 `org.bluez.Error.NotAuthorized` 轉為 ATT 0x08（Insufficient Authorization），`org.bluez.Error.NotPermitted` 轉為 Write Not Permitted。部分手機（特別是 iOS）收到驗證／授權類錯誤時可能觸發重新配對或進入不同錯誤流程。實機觀察後再決定使用哪一個。
- C 是正確性修正；修正後被拒的情況應極少，不能預期單靠 C 讓 App 恢復成功。

### 6.5 D：最小診斷資訊

對授權失敗記錄足以定位的原因：原始 device 型別、解析後路徑、匹配 active 或 candidate 的結果、配對接受狀態、bonded／paired／transport connected、是否正在清理舊 session。

不列印金鑰、不增加逐封包全量 log；避免只有 `Security error` 而無法知道失敗條件。

## 7. 非本次修改範圍

- BR 加密成功後的 HCI `0x0E` 安全性拒絕、BR 建立或監督逾時。
- `firstConnection` 在 Classic 全失敗時未結束，導致忽略後續真實 LE 斷線的問題。程式線索：`bluetooth_manager.cpp:833–836` 僅於 brReady 成功路徑清除，以及 `1254–1257` 的忽略分支；另案追查失敗收尾。
- CAN `0x512` timeout 的來源與手機收到 CAN error 時的行為。
- VIN 資料來自 CAN 的內容有效性、版本格式，以及手機 App 的內部失敗判定。
- 擷取分析器的錯誤碼文字及斷線發起方推斷修正。
- **Android 客戶APP配對(3)（`20261021-135837`）**：另案追查，本計畫 A／B／C 不會改善此情況。
  - 現象：BR 先做一次 AuthReq=0x00 的無 MITM、不 bonding 配對（Unauthenticated Link Key type 7），+7.55 s 手機即開啟 BR ATT 通道；約 13 秒後再做 General Bonding + MITM 配對（type 8）。整份紀錄手機對儀表沒有任何 ATT Request，D-Bus `WriteValue`／`StartNotify`／`ReadValue` 皆 0 筆；無 LE 連線；Classic 音訊正常；App 顯示失敗。
  - 與成功的 Android(1) 差異：(1) 只有一次 Dedicated Bonding + MITM 配對，ATT 通道在驗證配對之後開啟，接著立即探索與寫入。
  - 推論（缺手機端資料）：App 可能在無驗證配對階段就嘗試 GATT 而於手機端失敗；或 App 改走 LE，但儀表在 Bonded 後（+26 s）即關閉 LE 廣播。需手機端 `btsnoop_hci.log` 或 App log 確認。
  - 尚未比對：`20261021-135248`（catalog 名稱「客戶 APP 配對(2」，Android）是否為相同現象。
- 客戶 App 端行為（僅回報，不在儀表修正範圍）：iOS 版缺少查詢逾時重送；Android 版先寫 Control Point 後訂閱 Notify，第一輪回覆必然遺失。

## 8. 驗證與驗收條件

依應用程式專案規範，編譯及實機測試由使用者執行並回饋；本計畫不代表已在目標機驗證。

| 情境 | 預期結果 |
|---|---|
| iOS 客戶 App，兩端清除配對後首次連線 | 配對加密後立即送 VIN／版本查詢，也能通過本次候選者授權，不需等下一次 3 秒輪詢 |
| 首次 VIN 查詢 | 出現命令處理 log，回 `0x20` ACK 並對上原始 BID／序號，再回 `0x03` VIN 資料 |
| 首次版本查詢 | 出現命令處理 log，回 `0x20` ACK 並對上原始 BID／序號，再回 `0x06` 版本資料 |
| device option 是 object path | log 能取得完整路徑，不再把有效路徑當成空裝置 |
| 已提供但解析失敗／非目標手機 | 拒絕，D-Bus 與 ATT 顯示合理錯誤；不得借用其他手機 active 狀態放行 |
| 未接受配對／未 bonding／已斷線 | 不可因是候選者就提早允許 |
| 舊 slot 尚未清乾淨 | 不可提前授權新的候選 session |
| Android 原本 BR/EDR GATT 成功案例 | 控制命令、ACK、VIN／版本回覆及 Classic 音訊行為維持正常；因 A 改變授權路徑，log 應顯示完整裝置路徑且比對 active 成功 |
| 開機自動重連（iOS 換 RPA、Android） | 重連後的 Control Point 寫入能通過 `isActiveDeviceAddress(path)` |
| 被拒絕時 iOS／Android 的反應 | 記錄收到 ATT 0x08（或所選錯誤碼）後手機是否觸發重新配對、斷線或 App 錯誤，作為錯誤碼選擇依據 |
| B2 採用時 | Bonded 事件後立即看到提升 active 的 log，輪詢不再重複提升；Classic 補連、音訊、slot 狀態與原本一致 |
| nRF Connect | 一般探索及訂閱正常；在安全連線完成後手動送同樣 VIN／版本命令，確認也能處理 |
| 兩個已記憶手機與 FOB | 非目標手機／FOB 不得因本次候選授權而取得控制通道 |
| 正常／拒絕路徑 | 一次請求只有一次 D-Bus 回覆，沒有重複回覆、context 錯誤或崩潰 |

成功標準須分層記錄：

1. 儀表端：身分正確、候選授權成立、命令確實執行。
2. 封包端：ATT 結果與應用層結果一致，Common ACK 與資料能對應原始序號。
3. 手機端：確認 App 是否恢復初始化成功；若仍失敗，以已送出的查詢回覆、CAN error 及手機端 log 繼續追，不再把所有失敗籠統歸因為配對。

## 9. 執行順序與狀態

- [x] 對上三筆使用者指定紀錄與原始封包。
- [x] 追到 GATT 安全拒絕、active 提升時序與正常 D-Bus 回覆的程式位置。
- [x] 確認 VIN／版本命令與序號、CAN timeout 通知的協定定義。
- [x] 保存問題、證據、推斷及預定修改方案。
- [x] 補充 nRF(2)、Android nRF、Android 客戶 App 重送行為與 Android(3) 不同現象。
- [x] 分析器新增 GATT 寫入／Notify 事件顯示。
- [ ] 使用者確認修改範圍，並在 B1／B2 之間選定。
- [ ] 實作 A／B／C／D，維持修改集中於 GATT 與必要的 Manager 授權 helper。
- [ ] 使用者編譯、部署並回傳新的首次配對擷取。
- [ ] 依第 8 節確認 iOS 修正結果及 Android／單手機限制回歸。
- [ ] 若 App 仍失敗，取得手機端協定／錯誤資訊，區分 CAN 資料與 App 狀態機問題。
