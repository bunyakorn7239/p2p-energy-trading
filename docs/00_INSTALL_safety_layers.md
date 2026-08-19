# 🧩 คู่มือติดตั้ง Safety Layer 1 + 2 ลงใน repo `bunyakorn7239/p2p-energy-trading`

ตรวจสอบกับ commit `9cec836` ("update 27/7/2569 22:30") ซึ่งเป็น HEAD ปัจจุบัน

---

## 1. 📁 ไฟล์ใหม่ทั้งหมด — วางที่ไหน

```
p2p-energy-trading/
├── index.html                      ← ✏️ แก้ (เพิ่ม 5 บรรทัด <script>)
├── backend/
│   ├── server.py                   ← ✏️ แก้ (เพิ่ม 5 บรรทัดลงท้าย)
│   ├── violation_handler.py        ← ➕ ไฟล์ใหม่
│   ├── ieee33bus_network.py        ← ไม่แตะ
│   ├── matching.py                 ← ไม่แตะ
│   ├── market.py                   ← ไม่แตะ
│   └── energy_range_live.py        ← ไม่แตะ
├── js/
│   ├── app.js                      ← ไม่แตะ
│   ├── violationHandler.js         ← ไม่แตะ (ยังทำหน้าที่ DETECT เหมือนเดิม)
│   ├── liveRange.js                ← ไม่แตะ
│   ├── market.js                   ← ไม่แตะ
│   ├── safety1Notice.js            ← ➕ ไฟล์ใหม่
│   └── safety2/                    ← ➕ โฟลเดอร์ใหม่
│       ├── index.js                ← ➕ ตัวจัดการหลัก (registry + panel)
│       ├── overVoltage.js          ← ➕ เคส 1 (แก้ไขจริง)
│       ├── underVoltage.js         ← ➕ เคส 2 (แจ้งเตือน)
│       └── lineOverload.js         ← ➕ เคส 3 (แจ้งเตือน)
└── docs/                           ← ➕ โฟลเดอร์ใหม่
    ├── 00_INSTALL_safety_layers.md ← ไฟล์นี้
    ├── 01_zero_export.md
    ├── 02_under_voltage.md
    ├── 03_line_overload.md
    └── 04_post_curtailment_delivery.md   ← ➕ Phase 2 (ล็อกการจับคู่ + บัญชีค่าชดเชย)
```

**สรุป: เพิ่ม 9 ไฟล์ · แก้ของเดิมแค่ 2 ไฟล์ รวม 10 บรรทัด · ไม่ลบอะไรเลย**

---

## 2. ✏️ แพตช์ที่ 1 — `backend/server.py`

**ตำแหน่ง:** ท้ายไฟล์ (ราว **บรรทัด 847–852**) ตรงบล็อกที่ลงทะเบียน
`energy_range_live` อยู่แล้ว — ใต้หัวข้อ `# Entry point` และ
**เหนือ** `if __name__ == "__main__":`

**ของเดิม:**

```python
# --- LIVE feasible-range endpoint (separate module; nothing above changes) ---
try:
    from energy_range_live import bp_live
    app.register_blueprint(bp_live)
except Exception as _e:          # module missing -> app still runs as before
    print("energy_range_live not loaded:", _e)

if __name__ == "__main__":
```

**แก้เป็น (เพิ่มเฉพาะบล็อกกลาง):**

```python
# --- LIVE feasible-range endpoint (separate module; nothing above changes) ---
try:
    from energy_range_live import bp_live
    app.register_blueprint(bp_live)
except Exception as _e:          # module missing -> app still runs as before
    print("energy_range_live not loaded:", _e)

# --- SAFETY LAYER 2 (violation resolver; separate module) --------------------
try:
    from violation_handler import bp_safety2
    app.register_blueprint(bp_safety2)
except Exception as _e:
    print("violation_handler not loaded:", _e)

if __name__ == "__main__":
```

ℹ️ ใช้รูปแบบเดียวกับ `energy_range_live` เป๊ะ ๆ ถ้าไฟล์หาย
แอปก็ยังรันได้เหมือนเดิมทุกประการ (แค่ปุ่ม Safety 2 จะได้ 404)

---

## 3. ✏️ แพตช์ที่ 2 — `index.html`

**ตำแหน่ง:** บล็อก `<!-- ── SCRIPTS ── -->` ราว **บรรทัด 108–116**

**ของเดิม:**

```html
<script src="js/violationHandler.js"></script>
<script src="js/app.js"></script>
<script src="js/market.js"></script>
<script src="js/liveRange.js"></script>
```

**แก้เป็น:**

```html
<script src="js/violationHandler.js"></script>
<script src="js/app.js"></script>
<script src="js/market.js"></script>
<script src="js/liveRange.js"></script>

<!-- ── SAFETY LAYER 1 + 2 (add-on; ต้องโหลดหลัง app.js) ────────────── -->
<script src="js/safety1Notice.js"></script>
<script src="js/safety2/index.js"></script>
<script src="js/safety2/overVoltage.js"></script>
<script src="js/safety2/underVoltage.js"></script>
<script src="js/safety2/lineOverload.js"></script>
```

⚠️ **ลำดับสำคัญ:** `safety2/index.js` ต้องมาก่อนไฟล์เคสทั้งสาม
เพราะไฟล์เคสเรียก `window.Safety2.register()` ตอนโหลด

---

## 4. 🔌 API ใหม่ 1 เส้น

```
POST /api/violation/resolve
```

**Request**

```json
{
  "sellers": ["C","D","E","F","I"],
  "buyers": ["A","B","G","H","J"],
  "player_locations": { "C":"Bus14", "...": "..." },
  "seller_energy_kwh": { "C":11.95, "...": 0 },
  "buyer_energy_kwh":  { "A":4.469, "...": 0 },
  "seller_sold_kwh":   { "C":2.52,  "...": 0 },
  "buyer_bought_kwh":  { "A":4.469, "...": 0 },
  "trades": [ { "seller":"I", "buyer":"J", "qty":0.974, "price":4.48 } ]
}
```

- `seller_unsold_kwh` ใส่มาก็ได้ ถ้าไม่ใส่จะคำนวณเป็น
  `offered − sold` เหมือนที่ `/api/analyze` ทำ

**Response (ย่อ)**

```json
{
  "resolved": true,
  "action_taken": true,
  "initial": { "vmax": 1.050757, "n_over": 3, "over_buses": [23,24,25] },
  "final":   { "vmax": 1.035239, "n_over": 0 },
  "curtailed": [ { "seller":"D", "bus":25, "dVmax_dP":0.001477,
                   "lost_p2p_kwh":0.0, "lost_fit_kwh":11.95,
                   "affected_buyers":[], "cleared":true } ],
  "steps": [ { "cut":"D", "ranking":[ ... ], "before":{...}, "after":{...} } ],
  "dispatch": { "seller_sold_kwh":{...}, "surviving_trades":[...] },
  "notifications": [ { "title_th":"...", "why_th":"...", ... } ],
  "advisories": [],
  "power_flows": 7,
  "elapsed_s": 2.41
}
```

---

## 5. ✅ ผลการทดสอบจริง (รันบน container, pandapower 3.5.4, โค้ดที่ commit ไว้)

| เคสทดสอบ | Vmax ก่อน | ผู้ขายที่ถูกตัด | Vmax หลัง | คู่ค้าที่เหลือ | PF | เวลา |
|---|---|---|---|---|---|---|
| ประกาศที่เพดาน 10.86 พอดี | 1.046162 | — (ไม่ต้องตัด) | 1.046162 | 6/6 | 1 | 0.45 s |
| เพดาน × 1.10 | 1.050740 | **D** | 1.035227 | 6/6 | 7 | 2.30 s |
| เพดาน × 1.20 | 1.055228 | **D** | 1.038573 | 6/6 | 7 | 2.42 s |
| เพดาน × 2.20 | 1.095560 | **D → F** (2 รอบ) | 1.042579 | 5/5 | 12 | 4.05 s |
| D กระจุก 50 kWh | 1.076494 | **D** | 1.002023 | 3/7 | 7 | 2.34 s |
| ไม่มีใครขายเลย | 0.999275 | — | 0.999275 | 0/0 | 1 | 0.38 s |

**สิ่งที่ยืนยันได้จากตารางนี้**

1. ✅ **ลูปวนซ้ำทำงานจริง** — เคส ×2.20 ตัด D แล้วยังเกิน (1.0694)
   จึงตัด F ต่อจนหาย
2. ✅ **คู่ค้ารายอื่นไม่ถูกกระทบ** — เคส ×1.10/×1.20 ตัด D แต่คู่ซื้อขาย
   ยังครบ 6/6 คู่ (เพราะ D ขายไม่ได้อยู่แล้ว เหลือแต่ส่วน FiT)
3. ✅ **ถ้าผู้ถูกตัดมีคู่ค้าจริง ระบบบอกได้ว่าใครกระทบ** — เคส D กระจุก
   ตัด D → คู่ค้า A/B/G/H หลุด 4 คู่ ระบบระบุชื่อและปริมาณครบ
4. ✅ **เร็วพอ** — 2.4–4.1 วินาที อยู่ในหน้าต่าง Resolution 8 นาที
   และในช่วงย่อย 15 นาทีของ Safety Guard 2 อย่างสบาย
5. ✅ **line overload หายไปเอง** — เคส ×2.20 loading 122.9% → 68.9%

---

## 6. 🧪 วิธีทดสอบเองหลังติดตั้ง

```bash
# 1) รัน backend
bash start_backend.sh

# 2) ยิง endpoint ตรง ๆ
curl -X POST localhost:5001/api/violation/resolve \
  -H 'Content-Type: application/json' \
  -d '{"seller_energy_kwh":{"C":11.95,"D":11.95,"E":11.95,"F":11.95,"I":11.95},
       "buyer_energy_kwh":{"A":4.469,"B":7.769,"G":1.169,"H":1.169,"J":0.974},
       "seller_sold_kwh":{"C":2.52,"D":0,"E":0,"F":0,"I":11.95},
       "buyer_bought_kwh":{"A":4.469,"B":7.769,"G":1.169,"H":1.169,"J":0.974}}'

# 3) บนหน้าเว็บ
#    - ป้อนพลังงานผู้ขายเกิน 10.86 (เช่น 12–14 ทุกราย) → Run Analysis
#    - จะขึ้นแถบ Safety 1 เตือนสีแดง และเมื่อ power flow ไม่ผ่าน
#      จะขึ้นการ์ด Safety 2 พร้อมปุ่ม "รัน Safety 2 (Zero-Export อัตโนมัติ)"
```

---

## 7. 🔒 สิ่งที่ตั้งใจ **ไม่** เปลี่ยน

- ❌ ไม่แก้ `matching.py` — CP matching และ clearing price เหมือนเดิมทุกตัวอักษร
- ❌ ไม่แก้ `ieee33bus_network.py` — พารามิเตอร์โครงข่ายเดิม
- ❌ ไม่แก้ `market.py` — เฟสตลาด 5 ขั้นเดิม
- ❌ ไม่แก้ `app.js` / `violationHandler.js` — การตรวจจับและ UI เดิมทำงานปกติ
- ❌ **ไม่ใส่ hard block ที่ `/api/analyze`** — Safety 1 ยังเป็น
  **soft cap โดยตั้งใจ** เพื่อให้ผู้ใช้ป้อนเกินได้และ Safety 2 ได้ทำงาน

---

## 8. ⚠️ บั๊กเดิมที่ยังค้างอยู่ (ไม่ได้แก้ในชุดนี้ — แจ้งไว้เฉย ๆ)

ทั้งสองข้อนี้เคยยืนยันแล้วและ **ยังอยู่ใน HEAD** เป็นคนละเรื่องกับ
Safety 1/2 จึงไม่แตะตามที่สั่ง แต่ควรรู้ไว้:

1. **`market.py` บรรทัด 184 (`clear_slot`) และ 226 (`deliver_slot`)**
   เรียก `run_case("POST_MATCH", ...)` โดย **ไม่ส่ง `seller_unsold_kwh`**
   → ด่านตรวจความปลอดภัยในโหมดตลาดจึง **มองไม่เห็นพลังงานเหลือที่ขายเข้ากริด**
   (ที่ `server.py` ฉีดเป็น `DG_Seller{s}_GRID`) ทำให้ slot ที่ละเมิดจริง
   อาจผ่านด่านได้ · **แก้ได้ด้วยการเพิ่ม argument 1 ตัว**
   ⚠️ endpoint `/api/violation/resolve` ที่เพิ่มใหม่นี้ **ไม่มีปัญหานี้**
   เพราะคำนวณ `unsold = offered − sold` ให้เองเมื่อไม่ได้ส่งมา

2. **`/api/analyze` ตรวจแต่ราคา** (`FIT_PRICE ≤ p ≤ RETAIL_PRICE`)
   ไม่มีการตรวจเพดานพลังงานเลย — ซึ่งใน design นี้
   **ถือว่าถูกต้องตามเจตนา** (soft cap) แต่ต้องเขียนในเปเปอร์ให้ชัด
   ว่าเป็นการออกแบบ ไม่ใช่ของหลุด