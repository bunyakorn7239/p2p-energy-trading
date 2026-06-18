"""
market.py  –  ตลาด P2P ราย slot 1 ชั่วโมง (5 เฟส)
==================================================
ผูกกับ server.py เดิม โดยใช้ run_case, match_p2p, build_graph ที่มีอยู่แล้ว

วงจร 1 ชั่วโมง (เฟส 1 forecasting เว้นไว้ก่อน ใช้ค่าที่ผู้ใช้ป้อนเป็น forecast):
  เฟส 2  price_preview  – แสดงราคาเปรียบเทียบ grid vs P2P ก่อนกด submit
  เฟส 3  clear_slot     – price check + matching + power flow constraint check (scheduled)
  เฟส 4  deliver_slot   – ส่งพลังงานจริง + power flow ครั้งที่ 2 บนค่า actual
  เฟส 5  settle_slot    – คิดเงินจริง + ชดเชยส่วนขาด/ค่าปรับ + surplus management

การติดตั้ง: ใน server.py เพิ่ม 1 บรรทัดท้ายไฟล์ (ก่อน app.run)
    from market import register_market_routes
    register_market_routes(app)

หมายเหตุ: โมดูลนี้ตั้ง ENERGY_WINDOW_HOURS = 1.0 ให้อัตโนมัติ (ตลาดราย 1 ชม.
พลังงาน kWh ที่ป้อน = กำลังเฉลี่ยในชั่วโมงนั้น) จึงจับพีคของแต่ละชั่วโมงได้ตรง
ไม่ถูกค่าเฉลี่ย 24 ชม. กลบ
"""
from __future__ import annotations
from typing import Dict, List, Optional, Any

from flask import request, jsonify

import server
from server import (
    run_case, build_graph, generate_path_matrix, match_p2p,
    FIT_PRICE, RETAIL_PRICE, SELLERS, BUYERS, PLAYER_LOCATIONS,
)

# ตลาดราย slot 1 ชม. -> พลังงานที่ป้อน = กำลังเฉลี่ยในชั่วโมงนั้น
server.ENERGY_WINDOW_HOURS = 1.0


# =============================================================================
# ค่าคงที่ราคา  (ToU ของ PEA -- ใส่อัตราจริงตามประกาศ)
# =============================================================================
TOU_PEAK     = 5.80     # THB/kWh ช่วง peak    (placeholder ใส่ค่าจริง PEA)
TOU_OFFPEAK  = 2.60     # THB/kWh ช่วง off-peak (placeholder ใส่ค่าจริง PEA)
PEAK_HOURS   = set(range(9, 22))   # 09:00-21:59 โดยประมาณ ปรับตามประกาศ PEA


def tou_rate(hour: int) -> float:
    """อัตรา ToU ตามชั่วโมงของ slot (ใช้ตอนคิดส่วนขาด/ค่าปรับ)."""
    return TOU_PEAK if hour in PEAK_HOURS else TOU_OFFPEAK


# =============================================================================
# กติกาการคิดเงินส่วนที่ไม่ได้จับคู่  (ให้ตรงกับ server.py POST_MATCH และ app.js)
#   - Seller ที่ขายไม่ออก (unsold residual) -> ขายคืนกริดที่ราคา FIT
#       (ฝั่ง power flow: server.py inject เป็น sgen ก้อน DG_Seller{s}_GRID
#        ซึ่งอาจทำให้เกิด reverse power flow ออกกริด)
#   - Buyer ที่ซื้อไม่ครบ (unmet/deficit) -> ซื้อจากกริดหลักที่ราคา ToU
#   หมายเหตุ: เป็นกติกาเบื้องต้น เดี๋ยวมีการปรับปรุงอีกทีในภายหลัง
# =============================================================================
SETTLEMENT_NOTE = ("Provisional: seller residual -> grid @ FIT; "
                   "buyer deficit -> grid @ ToU. To be refined later.")


# =============================================================================
# State ของตลาด (in-memory; โปรดักชันค่อยย้ายไป DB)
# =============================================================================
MARKET_SLOTS: Dict[str, dict] = {}


def _new_slot(slot_id: str, hour: int) -> dict:
    MARKET_SLOTS[slot_id] = {
        "slot_id": slot_id, "hour": hour, "phase": "open",
        "orders": None, "clearing": None, "actual": None, "settlement": None,
    }
    return MARKET_SLOTS[slot_id]


def _orders_from(d: dict) -> dict:
    """ดึง order จาก request พร้อม default."""
    return {
        "hour": int(d.get("hour", 12)),
        "sellers": d.get("sellers", SELLERS),
        "buyers": d.get("buyers", BUYERS),
        "player_locations": d.get("player_locations", PLAYER_LOCATIONS),
        "offering_price": d["offering_price"],
        "bidding_price": d["bidding_price"],
        "seller_energy_kwh": d["seller_energy_kwh"],
        "buyer_energy_kwh": d["buyer_energy_kwh"],
    }


def _run_match(o: dict) -> dict:
    g = build_graph()
    pm = generate_path_matrix(g, o["sellers"], o["buyers"], o["player_locations"])
    return match_p2p(
        path_matrix=pm, sellers=o["sellers"], buyers=o["buyers"],
        bidding_price=o["bidding_price"], offering_price=o["offering_price"],
        seller_energy_kwh=o["seller_energy_kwh"], buyer_energy_kwh=o["buyer_energy_kwh"],
    )


# =============================================================================
# เฟส 2 : price preview  (แสดงก่อน submit)
# =============================================================================
def price_preview(o: dict) -> dict:
    """
    คำนวณราคาเปรียบเทียบให้แต่ละราย ก่อนกด submit:
      buyer  : ซื้อจากกริดล้วน  vs  ซื้อจาก P2P (+ ส่วนขาดซื้อกริด)
      seller : ขายกริดล้วนที่ FIT  vs  ขาย P2P (+ ส่วนเหลือขายกริด FIT)
    ใช้ provisional match บน order ปัจจุบันเพื่อประเมิน clearing price
    """
    hour = o["hour"]
    rate = tou_rate(hour)
    mr = _run_match(o)

    buyer_p2p_cost = {b: 0.0 for b in o["buyers"]}
    seller_p2p_rev = {s: 0.0 for s in o["sellers"]}
    for log in mr["logs"]:
        buyer_p2p_cost[log["buyer"]] += log["tradeValue"]
        seller_p2p_rev[log["seller"]] += log["tradeValue"]

    buyers_prev = {}
    for b in o["buyers"]:
        want = float(o["buyer_energy_kwh"][b])
        got = mr["boughtKwh"].get(b, 0.0)
        deficit = max(0.0, want - got)
        cost_grid = want * rate
        cost_p2p = buyer_p2p_cost[b] + deficit * rate
        buyers_prev[b] = {
            "want_kwh": round(want, 3), "p2p_kwh": round(got, 3),
            "cost_grid_only": round(cost_grid, 2), "cost_p2p": round(cost_p2p, 2),
            "save": round(cost_grid - cost_p2p, 2),
        }

    sellers_prev = {}
    for s in o["sellers"]:
        offer = float(o["seller_energy_kwh"][s])
        sold = mr["soldKwh"].get(s, 0.0)
        unsold = max(0.0, offer - sold)
        # Settlement rule (provisional, to be refined later):
        #   P2P-sold part  -> paid at the P2P clearing price (mid of bid/offer)
        #   unsold residual -> sold back to the grid at FIT
        rev_grid = offer * FIT_PRICE                  # baseline: sell everything to grid
        rev_p2p_only = seller_p2p_rev[s]              # revenue from matched trades
        grid_export_rev = unsold * FIT_PRICE          # residual exported to grid @ FIT
        rev_p2p = rev_p2p_only + grid_export_rev      # total under P2P + residual export
        sellers_prev[s] = {
            "offer_kwh": round(offer, 3), "p2p_kwh": round(sold, 3),
            "unsold_kwh": round(unsold, 3),
            "grid_export_kwh": round(unsold, 3),       # residual -> grid @ FIT
            "grid_export_rev": round(grid_export_rev, 2),
            "rev_p2p_only": round(rev_p2p_only, 2),
            "rev_grid_only": round(rev_grid, 2), "rev_p2p": round(rev_p2p, 2),
            "gain": round(rev_p2p - rev_grid, 2),
        }

    return {"hour": hour, "tou_rate": rate, "buyers": buyers_prev, "sellers": sellers_prev}


# =============================================================================
# เฟส 3 : clearing + power flow constraint check  (scheduled, ใช้ run_case เดิม)
# =============================================================================
def clear_slot(slot_id: str, o: dict) -> dict:
    slot = MARKET_SLOTS.get(slot_id) or _new_slot(slot_id, o["hour"])
    slot["orders"] = o
    sellers, buyers, pl = o["sellers"], o["buyers"], o["player_locations"]

    # --- price band check (FIT <= ราคา <= RETAIL) ---
    price_errors = []
    for s in sellers:
        p = o["offering_price"][s]
        if not (FIT_PRICE <= p <= RETAIL_PRICE):
            price_errors.append({"player": s, "role": "seller", "price": p})
    for b in buyers:
        p = o["bidding_price"][b]
        if not (FIT_PRICE <= p <= RETAIL_PRICE):
            price_errors.append({"player": b, "role": "buyer", "price": p})
    if price_errors:
        slot["clearing"] = {"ok": False, "price_errors": price_errors}
        slot["phase"] = "rejected"
        return slot["clearing"]

    # --- matching ---
    mr = _run_match(o)
    trade_price = {f'{l["seller"]}|{l["buyer"]}': l["clearPrice"] for l in mr["logs"]}

    # --- power flow constraint check (POST_MATCH; มี thermal แล้ว) ---
    pf = run_case("POST_MATCH", sellers, buyers, pl,
                  seller_sold_kwh=mr["soldKwh"], buyer_bought_kwh=mr["boughtKwh"])
    v = pf.get("violations", {})
    pf_ok = (len(v.get("under", [])) == 0 and len(v.get("over", [])) == 0
             and len(v.get("thermal", [])) == 0)

    slot["clearing"] = {
        "ok": pf_ok, "price_errors": [],
        "trades": mr["trades"], "sold": mr["soldKwh"], "bought": mr["boughtKwh"],
        "trade_price": trade_price, "violations": v, "metrics": pf.get("metrics", {}),
    }
    slot["phase"] = "cleared" if pf_ok else "violation"
    return slot["clearing"]


# =============================================================================
# เฟส 4 : ส่งพลังงานจริง + power flow ครั้งที่ 2 (actual)
# =============================================================================
def deliver_slot(slot_id: str, pv_realization: float = 1.0,
                 seller_factor: Optional[Dict[str, float]] = None,
                 actual_bought: Optional[Dict[str, float]] = None) -> dict:
    """
    ส่งพลังงานจริง:
      - seller_factor[s] = สัดส่วนที่ seller ส่งได้จริง (เช่นเมฆมา = 0.6).
        ถ้าไม่ระบุรายตัว ใช้ pv_realization เดียวกันหมด
      - buyer ได้รับจริงแบบ pro-rata ตาม factor ของ seller ในแต่ละ trade
      - รัน power flow ครั้งที่ 2 บนค่าจริงเพื่อยืนยัน feasibility ตอนส่ง
    """
    slot = MARKET_SLOTS[slot_id]
    cl = slot["clearing"]
    o = slot["orders"]

    fac = {s: (seller_factor.get(s, pv_realization) if seller_factor else pv_realization)
           for s in cl["sold"]}
    actual_sold = {s: cl["sold"][s] * fac[s] for s in cl["sold"]}

    # buyer ได้รับจริง = ผลรวมของแต่ละ trade x factor ของ seller นั้น
    actual_received = {b: 0.0 for b in o["buyers"]}
    for key, qty in cl["trades"].items():
        s, b = key.split("|")
        actual_received[b] += qty * fac.get(s, 1.0)

    pf = run_case("POST_MATCH", o["sellers"], o["buyers"], o["player_locations"],
                  seller_sold_kwh=actual_sold, buyer_bought_kwh=actual_received)

    slot["actual"] = {
        "factor": fac, "sold": actual_sold, "received": actual_received,
        "demand": actual_bought or cl["bought"],
        "violations": pf.get("violations", {}), "metrics": pf.get("metrics", {}),
    }
    slot["phase"] = "delivered"
    return slot["actual"]


# =============================================================================
# เฟส 5 : settlement + surplus management  (คิดเงินจริงตาม actual)
# =============================================================================
def settle_slot(slot_id: str) -> dict:
    """
    คิดเงินจริงตามพลังงานที่ส่ง/รับได้จริง:
      buyer  ได้ไม่ครบ -> ส่วนขาดซื้อจากกริดที่ ToU
      seller ส่งไม่ครบตามที่บอก -> เสียค่าปรับที่ราคากริด (เบื้องต้นใช้ ToU)
                 ผลิตเกิน (surplus) -> ขายกริดที่ FIT
    """
    slot = MARKET_SLOTS[slot_id]
    cl, act, o = slot["clearing"], slot["actual"], slot["orders"]
    rate = tou_rate(slot["hour"])
    bills = {}

    # ---- ผู้ซื้อ ----
    for b in o["buyers"]:
        want = cl["bought"].get(b, 0.0)
        got = act["received"].get(b, 0.0)
        deficit = max(0.0, want - got)
        p2p_paid = 0.0
        for key, qty in cl["trades"].items():
            s, bb = key.split("|")
            if bb == b:
                p2p_paid += qty * act["factor"].get(s, 1.0) * cl["trade_price"][key]
        grid_cost = deficit * rate
        bills[b] = {
            "role": "buyer", "want_kwh": round(want, 3), "received_kwh": round(got, 3),
            "grid_deficit_kwh": round(deficit, 3),
            "pay_p2p": round(p2p_paid, 2), "pay_grid": round(grid_cost, 2),
            "pay_total": round(p2p_paid + grid_cost, 2),
        }

    # ---- ผู้ขาย ----
    for s in o["sellers"]:
        claimed = cl["sold"].get(s, 0.0)
        delivered = act["sold"].get(s, 0.0)
        shortfall = max(0.0, claimed - delivered)
        surplus = max(0.0, delivered - claimed)
        rev = 0.0
        for key, qty in cl["trades"].items():
            ss, b = key.split("|")
            if ss == s:
                rev += qty * act["factor"].get(s, 1.0) * cl["trade_price"][key]
        penalty = shortfall * rate          # ส่งไม่ครบ -> ค่าปรับราคากริด
        grid_credit = surplus * FIT_PRICE   # ผลิตเกิน/ขายไม่ออก -> ขายกริดที่ FIT (ดู SETTLEMENT_NOTE)
        bills[s] = {
            "role": "seller", "claimed_kwh": round(claimed, 3),
            "delivered_kwh": round(delivered, 3), "shortfall_kwh": round(shortfall, 3),
            "revenue_p2p": round(rev, 2), "penalty": round(penalty, 2),
            "grid_credit": round(grid_credit, 2),
            "net": round(rev + grid_credit - penalty, 2),
        }

    slot["settlement"] = bills
    slot["phase"] = "settled"
    return bills


# =============================================================================
# ลงทะเบียน endpoint บน Flask app เดิม
# =============================================================================
def register_market_routes(app):

    @app.route("/api/market/preview", methods=["POST"])
    def _preview():
        return jsonify(price_preview(_orders_from(request.json or {})))

    @app.route("/api/market/clear", methods=["POST"])
    def _clear():
        d = request.json or {}
        return jsonify(clear_slot(d["slot_id"], _orders_from(d)))

    @app.route("/api/market/deliver", methods=["POST"])
    def _deliver():
        d = request.json or {}
        return jsonify(deliver_slot(
            d["slot_id"], float(d.get("pv_realization", 1.0)),
            d.get("seller_factor"), d.get("actual_bought")))

    @app.route("/api/market/settle", methods=["POST"])
    def _settle():
        d = request.json or {}
        return jsonify(settle_slot(d["slot_id"]))

    @app.route("/api/market/slot/<slot_id>", methods=["GET"])
    def _slot(slot_id):
        return jsonify(MARKET_SLOTS.get(slot_id, {"error": "slot not found"}))

    return app


# =============================================================================
# ทดสอบ 1 slot ครบ 5 เฟส  (python market.py)
# =============================================================================
if __name__ == "__main__":
    import warnings; warnings.filterwarnings("ignore")

    # order ตัวอย่าง (kWh ต่อ 1 ชม.) ราคาอยู่ในกรอบ [FIT, RETAIL], bid >= offer
    orders = _orders_from({
        "hour": 13,
        "offering_price": {s: 2.80 for s in SELLERS},
        "bidding_price":  {b: 5.20 for b in BUYERS},
        "seller_energy_kwh": {"C": 12, "D": 10, "E": 13, "F": 9, "I": 11},
        "buyer_energy_kwh":  {"A": 11, "B": 8,  "G": 9,  "H": 12, "J": 10},
    })
    sid = "2026-06-16T13:00"

    print("=" * 64)
    print("เฟส 2: price preview")
    pv = price_preview(orders)
    for b, x in pv["buyers"].items():
        print(f"  buyer {b}: want {x['want_kwh']} | grid {x['cost_grid_only']} vs P2P {x['cost_p2p']} -> save {x['save']}")

    print("\nเฟส 3: clear + power flow check")
    cl = clear_slot(sid, orders)
    print(f"  pf_ok = {cl['ok']} | thermal={len(cl['violations'].get('thermal',[]))} over={len(cl['violations'].get('over',[]))} under={len(cl['violations'].get('under',[]))}")
    print(f"  total traded = {round(sum(cl['sold'].values()),2)} kWh")

    print("\nเฟส 4: deliver จริง (สมมติเมฆมา seller ส่งได้ 70%)")
    ac = deliver_slot(sid, pv_realization=0.70)
    print(f"  actual sold รวม = {round(sum(ac['sold'].values()),2)} kWh | PF actual thermal={len(ac['violations'].get('thermal',[]))}")

    print("\nเฟส 5: settlement")
    bills = settle_slot(sid)
    print("  -- buyers --")
    for b in orders["buyers"]:
        x = bills[b]
        print(f"   {b}: รับจริง {x['received_kwh']} ขาด {x['grid_deficit_kwh']} | จ่าย P2P {x['pay_p2p']} + grid {x['pay_grid']} = {x['pay_total']}")
    print("  -- sellers --")
    for s in orders["sellers"]:
        x = bills[s]
        print(f"   {s}: ส่งจริง {x['delivered_kwh']} ขาด {x['shortfall_kwh']} | รายได้ {x['revenue_p2p']} ค่าปรับ {x['penalty']} net {x['net']}")
    print("=" * 64)