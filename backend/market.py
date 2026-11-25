"""
market.py  –  ตลาด P2P ราย slot 1 ชั่วโมง (5 เฟส)
==================================================
ผูกกับ server.py เดิม โดยใช้ run_case, match_p2p, build_graph ที่มีอยู่แล้ว
และใช้ Safety 2 ตัวเดียวกับหน้าเว็บ (violation_handler.py) — ไม่เขียนกติกาซ้ำ

วงจร 1 ชั่วโมง (เฟส 1 forecasting เว้นไว้ก่อน ใช้ค่าที่ผู้ใช้ป้อนเป็น forecast):
  เฟส 2  price_preview  – แสดงราคาเปรียบเทียบ grid vs P2P ก่อนกด submit
  เฟส 3  clear_slot     – price check + Safety 1 (soft cap, เตือนเท่านั้น)
                          + matching + PF verify (sold + unsold + โหลด buyer)
                          + Safety 2 ถ้ามี over-voltage
  เฟส 4  deliver_slot   – ส่งพลังงานจริง + PF ครั้งที่ 2 บนค่า actual
                          + Safety 2 อีกครั้งถ้า actual ทำให้ over-voltage
  เฟส 5  settle_slot    – คิดเงินตาม actual; ส่วนที่ถูก zero-export
                          บันทึกเป็น kWh (PENDING_SETTLEMENT) ยังไม่คิดเงิน

กติกาที่ต้องสอดคล้องกับ /api/analyze + /api/violation/resolve
  1) Safety 1 = SOFT CAP  (hard_per 10.86 kWh/ราย, hard_total 54.30 kWh)
       - ป้อนเกินได้ ระบบไม่ block เพียงคืนคำเตือนใน "safety1"
       - hard_total = 5 x hard_per พอดี -> total เกิน 54.30 ได้ก็ต่อเมื่อ
         มีอย่างน้อย 1 รายป้อนเกิน 10.86
  2) matching ตามปกติ (matching.py ไม่ถูกแตะ)
  3) PF verify POST_MATCH ต้องใส่ครบ:
       seller_sold_kwh   -> sgen DG_Seller{s}_P2P
       seller_unsold_kwh -> sgen DG_Seller{s}_GRID   (offer - sold, ขายกริดที่ FiT)
       buyer_energy_kwh  -> load ของ buyer (ถ้าไม่ส่ง load buyer = 0)
  4) ไม่มี violation -> ซื้อขายต่อ
     มี over-voltage  -> Safety 2: zero-export ผู้ขายที่ dVmax/dP สูงสุด,
                          รัน PF ซ้ำจนผ่าน, คู่ที่จับไว้ FROZEN (ไม่ re-match),
                          บันทึกพลังงานที่ค้างเป็น kWh, เรื่องเงินคิดภายหลัง
     under-V / line overload -> advisory เท่านั้น (เหมือนหน้าเว็บ)

การติดตั้ง: ใน server.py (มีอยู่แล้ว)
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
import violation_handler as vh   # Safety 2 ตัวเดียวกับหน้าเว็บ

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
# Safety 1 : soft cap  (อ่านค่าจาก server._DEFAULT_ER ตัวเดียวกับ /api/energy_range)
# =============================================================================
SAFETY1_PER_KWH   = float(getattr(server, "_DEFAULT_ER", {}).get("hard_per", 10.86))
SAFETY1_TOTAL_KWH = float(getattr(server, "_DEFAULT_ER", {}).get("hard_total", 54.30))


def safety1_check(o: dict) -> dict:
    """
    SOFT CAP: ตรวจและเตือนเท่านั้น ไม่ block (สอดคล้องกับ /api/analyze ที่ไม่มี
    การเช็คพลังงานฝั่ง server). ค่า 10.86 มาจาก binary search แบบทุกคนป้อนเท่ากัน
    และไม่มีโหลด จึงเป็นค่าอนุรักษ์นิยม — เกินแล้วไม่จำเป็นต้อง over-V เสมอ
    PF verify + Safety 2 เป็นตัวตัดสินจริง
    """
    over = []
    for s in o["sellers"]:
        q = float(o["seller_energy_kwh"].get(s, 0.0))
        if q > SAFETY1_PER_KWH + 1e-9:
            over.append({"seller": s, "offer_kwh": round(q, 4),
                         "cap_kwh": SAFETY1_PER_KWH,
                         "excess_kwh": round(q - SAFETY1_PER_KWH, 4)})
    total = sum(float(o["seller_energy_kwh"].get(s, 0.0)) for s in o["sellers"])
    total_over = total > SAFETY1_TOTAL_KWH + 1e-9
    warn_th = []
    if over:
        warn_th.append("ผู้ขาย " + ", ".join(x["seller"] for x in over)
                       + f" ป้อนเกินเพดาน {SAFETY1_PER_KWH} kWh/ราย — ระบบยังรับค่า "
                         "และจะตรวจด้วย PF verify / Safety 2")
    if total_over:
        warn_th.append(f"พลังงานรวม {total:.2f} kWh เกิน {SAFETY1_TOTAL_KWH} kWh "
                       "(แปลว่ามีอย่างน้อย 1 รายป้อนเกินเพดานรายคน)")
    return {
        "policy": "SOFT_CAP_WARN_ONLY",
        "blocked": False,                      # ไม่ block เด็ดขาด
        "cap_per_kwh": SAFETY1_PER_KWH, "cap_total_kwh": SAFETY1_TOTAL_KWH,
        "total_offer_kwh": round(total, 4), "total_over": total_over,
        "sellers_over": over, "warnings_th": warn_th,
    }


# =============================================================================
# กติกาการคิดเงินส่วนที่ไม่ได้จับคู่  (ให้ตรงกับ server.py POST_MATCH และ app.js)
#   - Seller ที่ขายไม่ออก (unsold residual) -> ขายคืนกริดที่ราคา FIT
#       (ฝั่ง power flow: inject เป็น sgen ก้อน DG_Seller{s}_GRID ด้วย)
#   - Buyer ที่ซื้อไม่ครบ (unmet/deficit) -> ซื้อจากกริดหลักที่ราคา ToU
#   - ส่วนที่ Safety 2 สั่ง zero-export -> บันทึกเฉพาะ kWh, เงินคิดภายหลัง
#   หมายเหตุ: เป็นกติกาเบื้องต้น เดี๋ยวมีการปรับปรุงอีกทีในภายหลัง
# =============================================================================
SETTLEMENT_NOTE = ("Provisional: seller residual -> grid @ FIT; "
                   "buyer deficit -> grid @ ToU; zero-exported energy -> "
                   "PENDING_SETTLEMENT (kWh only). To be refined later.")
PENDING_NOTE_TH = "จะทำการคิดการชำระเงินเพิ่มเติมภายหลัง"


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
# Helper : PF verify + Safety 2  (ใช้ทั้งเฟส 3 และเฟส 4)
# =============================================================================
def _pf_post(o: dict, export_kwh: Dict[str, float], sold: Dict[str, float],
             bought: Dict[str, float], unsold: Dict[str, float]) -> dict:
    """POST_MATCH ที่ใส่ครบ: sold + unsold (ฝั่ง seller) และ demand (ฝั่ง buyer)."""
    return run_case("POST_MATCH", o["sellers"], o["buyers"], o["player_locations"],
                    seller_energy_kwh=export_kwh,
                    buyer_energy_kwh=o["buyer_energy_kwh"],
                    seller_sold_kwh=sold, buyer_bought_kwh=bought,
                    seller_unsold_kwh=unsold)


def _has_violation(pf: dict) -> bool:
    v = (pf or {}).get("violations", {}) or {}
    return bool(v.get("over") or v.get("under") or v.get("thermal"))


def _verify_and_resolve(o: dict, export_kwh: Dict[str, float],
                        trades: List[dict], already_removed: List[str]) -> dict:
    """
    PF verify บนการส่งมอบที่กำหนด แล้วถ้ามี over-voltage เรียก Safety 2
    (vh.resolve_over_voltage + vh.apply_curtailment) — ตัวเดียวกับหน้าเว็บ.

    export_kwh : พลังงานที่ seller แต่ละรายฉีดจริง (= sold + unsold)
    trades     : คู่ที่จับไว้ [{seller, buyer, qty, price}] (FROZEN)
    """
    vh._ensure()
    sellers, buyers = o["sellers"], o["buyers"]
    rm0 = set(already_removed)
    live = [t for t in trades if t["seller"] not in rm0]

    sold = {s: 0.0 for s in sellers}
    bought = {b: 0.0 for b in buyers}
    for t in live:
        sold[t["seller"]] += float(t["qty"])
        bought[t["buyer"]] += float(t["qty"])
    unsold = {s: (0.0 if s in rm0 else max(0.0, float(export_kwh.get(s, 0.0)) - sold[s]))
              for s in sellers}

    pf = _pf_post(o, export_kwh, sold, bought, unsold)
    out = {
        "pf_initial": vh._pf_summary(pf), "pf_raw": pf,
        "safety2": None, "removed": list(already_removed),
        "trades": live, "sold": sold, "bought": bought, "unsold": unsold,
    }
    if not pf.get("converged"):
        out["ok"] = False
        out["pf_final"] = out["pf_initial"]
        return out
    if not (pf.get("violations", {}) or {}).get("over"):
        out["ok"] = not _has_violation(pf)
        out["pf_final"] = out["pf_initial"]
        return out

    # ---- Safety 2 : over-voltage -> zero-export ผู้ขายที่ dVmax/dP สูงสุด ----
    res = vh.resolve_over_voltage(
        sellers, buyers, o["player_locations"],
        export_kwh, o["buyer_energy_kwh"], sold, bought, unsold, trades=live)
    new_cut = [c["seller"] for c in res.get("curtailed", [])]
    removed = list(already_removed) + [s for s in new_cut if s not in rm0]

    # PHASE 2: frozen match — ยกเลิกเฉพาะคู่ของผู้ขายที่ถูกตัด แล้วรัน PF ซ้ำ
    ac = vh.apply_curtailment(
        sellers, buyers, o["player_locations"],
        export_kwh, o["buyer_energy_kwh"],
        o["offering_price"], o["bidding_price"],
        removed=removed, trades_before=trades)
    pf2 = ac["power_flow"]["post_match"]
    st = ac["settlement"]
    survivors = [{"seller": t["seller"], "buyer": t["buyer"],
                  "qty": t["qty_kwh"], "price": t["price"]}
                 for t in ac["trades_delivered"]]

    out.update({
        "safety2": {
            "triggered": True, "resolved": bool(res.get("resolved")),
            "curtailed": res.get("curtailed", []), "steps": res.get("steps", []),
            "notifications": res.get("notifications", []),
            "power_flows": res.get("power_flows"), "elapsed_s": res.get("elapsed_s"),
            "matching_policy": ac["matching_policy"],
            "trades_cancelled": ac["trades_cancelled"],
            "energy_ledger": {
                "buyer_energy_shortfall": st["buyer_energy_shortfall"],
                "seller_energy_undelivered": st["seller_energy_undelivered"],
                "ledger_basis": st["ledger_basis"], "note_th": PENDING_NOTE_TH,
            },
        },
        "removed": removed, "trades": survivors,
        "sold": dict(st["seller_sold_kwh"]), "bought": dict(st["buyer_bought_kwh"]),
        "unsold": dict(st["seller_unsold_kwh"]),
        "pf_raw": pf2, "pf_final": vh._pf_summary(pf2),
        "ok": isinstance(pf2, dict) and pf2.get("converged", False) and not _has_violation(pf2),
    })
    return out


def _advisories(pf: dict) -> List[dict]:
    s = vh._pf_summary(pf)
    adv = []
    if s.get("n_under", 0) > 0:
        adv.append(vh.advise_under_voltage(s))
    if s.get("n_thermal", 0) > 0:
        adv.append(vh.advise_line_overload(s))
    return adv


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

    return {"hour": hour, "tou_rate": rate, "buyers": buyers_prev,
            "sellers": sellers_prev, "safety1": safety1_check(o)}


# =============================================================================
# เฟส 3 : clearing + Safety 1 (soft) + PF verify + Safety 2
# =============================================================================
def clear_slot(slot_id: str, o: dict) -> dict:
    slot = MARKET_SLOTS.get(slot_id) or _new_slot(slot_id, o["hour"])
    slot["orders"] = o
    sellers, buyers = o["sellers"], o["buyers"]

    # --- price band check (FIT <= ราคา <= RETAIL) — เหมือน /api/analyze ---
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

    # --- Safety 1 : soft cap (เตือนเท่านั้น ไม่ block) ---
    s1 = safety1_check(o)

    # --- matching (matching.py ไม่ถูกแตะ) ---
    mr = _run_match(o)
    trades = [{"seller": l["seller"], "buyer": l["buyer"],
               "qty": float(l["qty"]), "price": l["clearPrice"]} for l in mr["logs"]]
    trade_price = {f'{l["seller"]}|{l["buyer"]}': l["clearPrice"] for l in mr["logs"]}
    unsold_matched = {s: max(0.0, float(o["seller_energy_kwh"].get(s, 0.0))
                             - float(mr["soldKwh"].get(s, 0.0))) for s in sellers}

    # --- PF verify (sold + unsold + โหลด buyer) และ Safety 2 ถ้า over-V ---
    declared = {s: float(o["seller_energy_kwh"].get(s, 0.0)) for s in sellers}
    r = _verify_and_resolve(o, declared, trades, already_removed=[])
    pf = r["pf_raw"]

    # ตาราง trades ในรูปแบบเดิม (key "S|B" -> kWh) หลัง Safety 2
    trades_map: Dict[str, float] = {}
    for t in r["trades"]:
        k = f'{t["seller"]}|{t["buyer"]}'
        trades_map[k] = trades_map.get(k, 0.0) + float(t["qty"])

    phase = ("cleared" if r["ok"] and not r["safety2"]
             else "cleared_after_safety2" if r["ok"]
             else "violation")

    slot["clearing"] = {
        # ---- key เดิม (js/market.js ใช้อยู่) : เป็นสถานะ "หลัง" Safety 2 ----
        "ok": r["ok"], "price_errors": [],
        "trades": trades_map, "sold": r["sold"], "bought": r["bought"],
        "trade_price": trade_price,
        "violations": (pf or {}).get("violations", {}),
        "metrics": (pf or {}).get("metrics", {}),
        # ---- key ใหม่ ----
        "unsold": r["unsold"],
        "safety1": s1,
        "match_before_safety2": {
            "trades": trades, "sold": mr["soldKwh"], "bought": mr["boughtKwh"],
            "unsold": unsold_matched,
        },
        "pf_initial": r["pf_initial"], "pf_final": r["pf_final"],
        "safety2": r["safety2"] or {"triggered": False},
        "curtailed_sellers": r["removed"],
        "advisories": _advisories(pf),
        "frozen_trades": r["trades"],
    }
    slot["phase"] = phase
    return slot["clearing"]


# =============================================================================
# เฟส 4 : ส่งพลังงานจริง + PF ครั้งที่ 2 (actual) + Safety 2 (real-time)
# =============================================================================
def deliver_slot(slot_id: str, pv_realization: float = 1.0,
                 seller_factor: Optional[Dict[str, float]] = None,
                 actual_bought: Optional[Dict[str, float]] = None) -> dict:
    """
    ส่งพลังงานจริง:
      - seller_factor[s] = สัดส่วน PV จริงเทียบกับที่เสนอ (เมฆมา = 0.6, ผลิตเกิน = 1.2)
        ถ้าไม่ระบุรายตัว ใช้ pv_realization เดียวกันหมด
      - พลังงานที่ฉีดจริง = (sold + unsold) x factor  (unsold ถูก scale ด้วย)
      - ส่งให้ buyer ได้ไม่เกินสัญญา: qty x min(factor, 1); ส่วนเกิน -> FiT
      - ผู้ขายที่ถูก zero-export ตั้งแต่เฟส 3 ฉีด = 0
      - รัน PF บนค่าจริง ถ้า over-V -> Safety 2 อีกครั้ง (คู่เดิม FROZEN)
    """
    slot = MARKET_SLOTS[slot_id]
    cl = slot["clearing"]
    o = slot["orders"]
    sellers = o["sellers"]
    removed0 = list(cl.get("curtailed_sellers", []))

    fac = {s: (float(seller_factor.get(s, pv_realization)) if seller_factor
               else float(pv_realization)) for s in sellers}

    # พลังงานจริงที่ฉีด (ผู้ขายที่ถูกตัดแล้ว = 0)
    export_act = {s: (0.0 if s in removed0 else
                      (cl["sold"].get(s, 0.0) + cl.get("unsold", {}).get(s, 0.0)) * fac[s])
                  for s in sellers}
    trades_act = [{"seller": t["seller"], "buyer": t["buyer"],
                   "qty": float(t["qty"]) * min(fac[t["seller"]], 1.0),
                   "price": t["price"]}
                  for t in cl.get("frozen_trades", [])]

    r = _verify_and_resolve(o, export_act, trades_act, already_removed=removed0)
    pf = r["pf_raw"]

    actual_received = {b: 0.0 for b in o["buyers"]}
    for t in r["trades"]:
        actual_received[t["buyer"]] += float(t["qty"])

    slot["actual"] = {
        # ---- key เดิม ----
        "factor": fac, "sold": r["sold"], "received": actual_received,
        "demand": actual_bought or cl["bought"],
        "violations": (pf or {}).get("violations", {}),
        "metrics": (pf or {}).get("metrics", {}),
        # ---- key ใหม่ ----
        "ok": r["ok"], "unsold": r["unsold"], "export_kwh": export_act,
        "pf_initial": r["pf_initial"], "pf_final": r["pf_final"],
        "safety2": r["safety2"] or {"triggered": False},
        "curtailed_sellers": r["removed"],
        "curtailed_at_delivery": [s for s in r["removed"] if s not in removed0],
        "advisories": _advisories(pf),
        "delivered_trades": r["trades"],
    }
    slot["phase"] = "delivered" if r["ok"] else "delivered_with_violation"
    return slot["actual"]


# =============================================================================
# เฟส 5 : settlement + surplus management  (คิดเงินจริงตาม actual)
# =============================================================================
def settle_slot(slot_id: str) -> dict:
    """
    คิดเงินจริงตามพลังงานที่ส่ง/รับได้จริง:
      buyer  ได้ไม่ครบเพราะ seller ผลิตไม่พอ -> ส่วนขาดซื้อจากกริดที่ ToU
      seller ส่งไม่ครบตามสัญญา (ตัวเอง)     -> ค่าปรับที่ราคากริด (เบื้องต้นใช้ ToU)
      seller ขายไม่ออก + ผลิตเกิน            -> ขายกริดที่ FIT
      คู่ที่ถูกยกเลิกเพราะ Safety 2 zero-export (no-fault ของตลาด)
             -> ไม่คิดเงินในรอบนี้ บันทึกเฉพาะ kWh เป็น PENDING_SETTLEMENT
    """
    slot = MARKET_SLOTS[slot_id]
    cl, act, o = slot["clearing"], slot["actual"], slot["orders"]
    rate = tou_rate(slot["hour"])
    removed = set(act.get("curtailed_sellers", []))
    bills: Dict[str, Any] = {}

    # คู่ตามสัญญาหลังเฟส 3 (frozen) และคู่ที่ส่งจริงหลังเฟส 4
    contract = {f'{t["seller"]}|{t["buyer"]}': float(t["qty"])
                for t in cl.get("frozen_trades", [])}
    delivered = {}
    for t in act.get("delivered_trades", []):
        k = f'{t["seller"]}|{t["buyer"]}'
        delivered[k] = delivered.get(k, 0.0) + float(t["qty"])

    # รวมทุกคู่ที่ถูก zero-export (ทั้งเฟส 3 และเฟส 4) ตามสัญญาเดิมก่อนตัด
    orig = {f'{t["seller"]}|{t["buyer"]}': float(t["qty"])
            for t in cl.get("match_before_safety2", {}).get("trades", [])}
    pending_by_key = {k: q for k, q in orig.items() if k.split("|")[0] in removed}

    # ---- ผู้ซื้อ ----
    for b in o["buyers"]:
        want = sum(q for k, q in contract.items() if k.split("|")[1] == b)
        got = sum(q for k, q in delivered.items() if k.split("|")[1] == b)
        deficit = max(0.0, want - got)       # ขาดเพราะ seller ผลิตไม่พอ (ไม่ใช่ Safety 2)
        pend = sum(q for k, q in pending_by_key.items() if k.split("|")[1] == b)
        p2p_paid = sum(q * cl["trade_price"][k] for k, q in delivered.items()
                       if k.split("|")[1] == b)
        grid_cost = deficit * rate
        bills[b] = {
            "role": "buyer", "want_kwh": round(want, 3), "received_kwh": round(got, 3),
            "grid_deficit_kwh": round(deficit, 3),
            "pay_p2p": round(p2p_paid, 2), "pay_grid": round(grid_cost, 2),
            "pay_total": round(p2p_paid + grid_cost, 2),
            "curtailed_shortfall_kwh": round(pend, 3),
            "settlement_status": "PENDING_SETTLEMENT" if pend > 1e-9 else "FINAL",
            "note_th": PENDING_NOTE_TH if pend > 1e-9 else "",
        }

    # ---- ผู้ขาย ----
    for s in o["sellers"]:
        if s in removed:
            declared = float(o["seller_energy_kwh"].get(s, 0.0))
            pend_p2p = sum(q for k, q in pending_by_key.items() if k.split("|")[0] == s)
            bills[s] = {
                "role": "seller", "claimed_kwh": 0.0, "delivered_kwh": 0.0,
                "shortfall_kwh": 0.0, "unsold_kwh": 0.0,
                "revenue_p2p": 0.0, "penalty": 0.0, "grid_credit": 0.0, "net": 0.0,
                "zero_exported": True,
                "undelivered_p2p_kwh": round(pend_p2p, 3),
                "undelivered_total_kwh": round(declared, 3),
                "settlement_status": "PENDING_SETTLEMENT",
                "note_th": PENDING_NOTE_TH,
            }
            continue
        claimed = sum(q for k, q in contract.items() if k.split("|")[0] == s)
        deliv = sum(q for k, q in delivered.items() if k.split("|")[0] == s)
        shortfall = max(0.0, claimed - deliv)
        unsold_act = float(act.get("unsold", {}).get(s, 0.0))   # ขายไม่ออก + ผลิตเกิน
        rev = sum(q * cl["trade_price"][k] for k, q in delivered.items()
                  if k.split("|")[0] == s)
        penalty = shortfall * rate          # ส่งไม่ครบเอง -> ค่าปรับราคากริด
        grid_credit = unsold_act * FIT_PRICE
        bills[s] = {
            "role": "seller", "claimed_kwh": round(claimed, 3),
            "delivered_kwh": round(deliv, 3), "shortfall_kwh": round(shortfall, 3),
            "unsold_kwh": round(unsold_act, 3),
            "revenue_p2p": round(rev, 2), "penalty": round(penalty, 2),
            "grid_credit": round(grid_credit, 2),
            "net": round(rev + grid_credit - penalty, 2),
            "zero_exported": False, "settlement_status": "FINAL",
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

    # order ตัวอย่าง: D ป้อนเกิน 10.86 (soft cap) -> ระบบยังรับ, PF verify ตัดสิน
    orders = _orders_from({
        "hour": 13,
        "offering_price": {"C": 3.0, "D": 5.6, "E": 5.6, "F": 3.2, "I": 3.1},
        "bidding_price":  {b: 5.00 for b in BUYERS},
        "seller_energy_kwh": {"C": 10.86, "D": 13.0, "E": 10.86, "F": 10.86, "I": 10.86},
        "buyer_energy_kwh":  {"A": 4, "B": 4, "G": 3, "H": 3, "J": 3},
    })
    sid = "2026-06-16T13:00"

    print("=" * 64)
    print("เฟส 3: Safety 1 (soft) + clear + PF verify + Safety 2")
    cl = clear_slot(sid, orders)
    for w in cl["safety1"]["warnings_th"]:
        print("  ⚠️", w)
    print(f"  PF ก่อน Safety 2 : Vmax {cl['pf_initial']['vmax']} over {cl['pf_initial']['n_over']}")
    print(f"  zero-export      : {cl['curtailed_sellers']}")
    print(f"  PF หลัง Safety 2 : Vmax {cl['pf_final']['vmax']} over {cl['pf_final']['n_over']} | ok = {cl['ok']}")

    print("\nเฟส 4: deliver จริง (PV ตามที่เสนอ)")
    ac = deliver_slot(sid, pv_realization=1.0)
    print(f"  Vmax {ac['pf_final']['vmax']} | ok = {ac['ok']}")

    print("\nเฟส 5: settlement")
    bills = settle_slot(sid)
    for k, x in bills.items():
        print(f"   {k}: {x}")
    print("=" * 64)
