function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT"
    : a === b ? "EQ" : "GT"};
}

function nat_divmod(a, b) {
  return b === 0 ? {$: "Tuple", fst: 0, snd: a}
    : {$: "Tuple", fst: Math.trunc(a / b), snd: a % b};
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_host(n) {
  const int = typeof n === "bigint" || Number.isInteger(n);
  if (int && n >= 0 && n <= 2 ** 53) {
    return Number(n);
  }
  return { [Symbol.toPrimitive]() { throw "bend: a Nat past the largest immediate 2^48-1"; } };
}

function f32_show(x) {
  if (x !== x) {
    return "nan";
  }
  if (!Number.isFinite(x) || Object.is(x, -0)) {
    return x < 0 ? "-inf"
      : x === 0 ? "-0" : "inf";
  }
  let s = "x";
  for (let p = 1; p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return s;
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^\s*[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  const v = f32_round(s.replace(/inf\w*/i, "Infinity"));
  return re.test(s) ? {$: "Some", value: v} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

function char_new(code) {
  if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
    throw "bend: " + code + " is not a Unicode scalar value";
  }
  return String.fromCodePoint(code);
}

// Array
// =====

function array_new(d, v) {
  if (d > 31) {
    throw "bend: an array past the deepest block class 31";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const at = i % a.length;
  const old = a[at];
  a[at] = f(old);
  return {$: "Tuple", fst: a, snd: old};
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x: [x]};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(...r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : f(...a);
}

// Effect
// ======

const $0eff = Object.create(null);

function io_eff(k, run, need) {
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = { run, need };
}
// Program
// =======

function $pow2$(_l_0) {
  if (_l_0 === 0) {
    return 1;
  } else {
    const _p_0 = (_l_0 - 1);
    const _x_0 = ($pow2$(_p_0));
    return nat_chk(_x_0 + _x_0);
  }
}

function $start$(_l_0, _i_0) {
  const _x_0 = ($pow2$(_l_0));
  return nat_chk(_i_0 * _x_0);
}

function $log2$step$(_c_0, _l_0) {
  if (_c_0.$ === "LT") {
    return {$: "Below", "l": nat_chk(_l_0 + 1)};
  } else if (_c_0.$ === "EQ") {
    return {$: "Found", "l": _l_0};
  } else {
    return {$: "Past"};
  }
}

function $log2$done$(_st_0) {
  if (_st_0.$ === "Below") {
    return {$: "None"};
  } else if (_st_0.$ === "Found") {
    const _l_0 = _st_0["l"];
    return {$: "Some", "value": _l_0};
  } else {
    return {$: "None"};
  }
}

function $log2$($0, $1, $2) {
  for (;;) {
    {
      const _fuel_0 = $0;
      const _st_0 = $1;
      const _n_0 = $2;
      if (_fuel_0 === 0) {
        return $log2$done$(_st_0);
      } else {
        const _f_0 = (_fuel_0 - 1);
        if (_st_0.$ === "Below") {
          const _l_0 = _st_0["l"];
          const _x_0 = ($pow2$(_l_0));
          $0 = _f_0;
          $1 = ($log2$step$(cmp_new(_x_0, _n_0), _l_0));
          $2 = _n_0;
          continue;
        } else if (_st_0.$ === "Found") {
          const _l_1 = _st_0["l"];
          return {$: "Some", "value": _l_1};
        } else {
          return {$: "None"};
        }
      }
    }
  }
}

function $coords$check$(_ok_0, _l_0, _i_0) {
  if (_ok_0) {
    return {$: "Some", "value": {$: "Coord", "l": _l_0, "i": _i_0}};
  } else {
    return {$: "None"};
  }
}

function $coords$at$(_id_0, _n_0, _T_0, _ml_0) {
  if (_ml_0.$ === "None") {
    return {$: "None"};
  } else {
    const _l_0 = _ml_0["value"];
    const _i_0 = ($Nat$div$(_id_0, _n_0));
    const _ok_0 = ($Bool$and$(($Nat$is_eq$(($start$(_l_0, _i_0)), _id_0)), ($Nat$is_le$(nat_chk(_id_0 + _n_0), _T_0))));
    return $coords$check$(_ok_0, _l_0, _i_0);
  }
}

function $coords$(_id_0, _n_0, _T_0) {
  return $coords$at$(_id_0, _n_0, _T_0, ($log2$(nat_chk(_n_0 + 1), {$: "Below", "l": 0}, _n_0)));
}

function $rev_onto$($0, $1) {
  for (;;) {
    {
      const _xs_0 = $0;
      const _acc_0 = $1;
      if (_xs_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _h_0 = _xs_0["head"];
        const _t_0 = _xs_0["tail"];
        $0 = _t_0;
        $1 = {$: "Con", "head": _h_0, "tail": _acc_0};
        continue;
      }
    }
  }
}

function $total$($0, $1) {
  for (;;) {
    {
      const _ps_0 = $0;
      const _acc_0 = $1;
      if (_ps_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _t_0 = _ps_0["head"];
        const _s_0 = _t_0["size"];
        const _rest_0 = _ps_0["tail"];
        $0 = _rest_0;
        $1 = nat_chk(_acc_0 + _s_0);
        continue;
      }
    }
  }
}

function $size$(_ps_0) {
  return $total$(_ps_0, 0);
}

function $built_up$(_ups_0) {
  if (_ups_0.$ === "Nil") {
    return false;
  } else {
    return true;
  }
}

function $mergeable$(_a_0, _b_0) {
  const _la_0 = _a_0["l"];
  const _ia_0 = _a_0["i"];
  const _ups_0 = _a_0["ups"];
  const _lb_0 = _b_0["l"];
  const _ib_0 = _b_0["i"];
  const _j_0 = ($Nat$div$(_ia_0, 2));
  return $Bool$and$(($Bool$and$(($Bool$and$(($Nat$is_eq$(_la_0, _lb_0)), ($Nat$is_eq$(nat_chk(_j_0 + _j_0), _ia_0)))), ($Nat$is_eq$(nat_chk(_ia_0 + 1), _ib_0)))), ($built_up$(_ups_0)));
}

function $parent$(_a_0) {
  const _l_0 = _a_0["l"];
  const _i_0 = _a_0["i"];
  const _s_0 = _a_0["size"];
  const _b_0 = _a_0["built"];
  const _t_0 = _a_0["ups"];
  if (_t_0.$ === "Nil") {
    return {$: "Part", "l": _l_0, "i": _i_0, "size": _s_0, "built": _b_0, "ups": {$: "Nil"}};
  } else {
    const _u_0 = _t_0["head"];
    const _us_0 = _t_0["tail"];
    return {$: "Part", "l": nat_chk(_l_0 + 1), "i": ($Nat$div$(_i_0, 2)), "size": _u_0, "built": true, "ups": _us_0};
  }
}

function $more_due$(_T_0, _a_0, _b_0) {
  const _ea_0 = _a_0["e"];
  const _la_0 = _a_0["l"];
  const _eb_0 = _b_0["e"];
  const _lb_0 = _b_0["l"];
  const _x_0 = nat_chk(_T_0 + 1);
  const _x_1 = (_x_0 < _ea_0 ? 0 : _x_0 - _ea_0);
  const _x_2 = ($pow2$(_lb_0));
  const _x_3 = nat_chk(_T_0 + 1);
  const _x_4 = (_x_3 < _eb_0 ? 0 : _x_3 - _eb_0);
  const _x_5 = ($pow2$(_la_0));
  return $Nat$is_gt$(nat_chk(_x_1 * _x_2), nat_chk(_x_4 * _x_5));
}

function $choose$vs$(_win_0, _cand_0, _cur_0) {
  if (_win_0) {
    return {$: "Some", "value": _cand_0};
  } else {
    return {$: "Some", "value": _cur_0};
  }
}

function $choose$(_T_0, _ok_0, _cand_0, _acc_0) {
  if (!_ok_0) {
    return _acc_0;
  } else {
    if (_acc_0.$ === "None") {
      return {$: "Some", "value": _cand_0};
    } else {
      const _cur_0 = _acc_0["value"];
      return $choose$vs$(($more_due$(_T_0, _cand_0, _cur_0)), _cand_0, _cur_0);
    }
  }
}

function $pick$(_T_0, _a_0, _b_0, _k_0, _acc_0) {
  const _l_0 = _a_0["l"];
  const _i_0 = _a_0["i"];
  const __0 = _a_0["size"];
  const __1 = _a_0["built"];
  const __2 = _a_0["ups"];
  return $choose$(_T_0, ($mergeable$({$: "Part", "l": _l_0, "i": _i_0, "size": __0, "built": __1, "ups": __2}, _b_0)), {$: "Best", "k": _k_0, "e": ($start$(_l_0, nat_chk(_i_0 + 2))), "l": _l_0}, _acc_0);
}

function $best$go$($0, $1, $2, $3) {
  for (;;) {
    {
      const _ps_0 = $0;
      const _T_0 = $1;
      const _k_0 = $2;
      const _acc_0 = $3;
      if (_ps_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _a_0 = _ps_0["head"];
        const _t_0 = _ps_0["tail"];
        if (_t_0.$ === "Nil") {
          return _acc_0;
        } else {
          const _b_0 = _t_0["head"];
          const __0 = _t_0["tail"];
          $0 = {$: "Con", "head": _b_0, "tail": __0};
          $1 = _T_0;
          $2 = nat_chk(_k_0 + 1);
          $3 = ($pick$(_T_0, _a_0, _b_0, _k_0, _acc_0));
          continue;
        }
      }
    }
  }
}

function $best$(_T_0, _ps_0) {
  return $best$go$(_ps_0, _T_0, 0, {$: "None"});
}

function $merge_head$(_a_0, _rest_0) {
  if (_rest_0.$ === "Nil") {
    return {$: "Con", "head": _a_0, "tail": {$: "Nil"}};
  } else {
    const _more_0 = _rest_0["tail"];
    return {$: "Con", "head": ($parent$(_a_0)), "tail": _more_0};
  }
}

function $merge_at$go$($0, $1, $2) {
  for (;;) {
    {
      const _ps_0 = $0;
      const _k_0 = $1;
      const _done_0 = $2;
      if (_ps_0.$ === "Nil") {
        return $rev_onto$(_done_0, {$: "Nil"});
      } else {
        const _a_0 = _ps_0["head"];
        const _rest_0 = _ps_0["tail"];
        if (_k_0 === 0) {
          return $rev_onto$(_done_0, ($merge_head$(_a_0, _rest_0)));
        } else {
          const _j_0 = (_k_0 - 1);
          $0 = _rest_0;
          $1 = _j_0;
          $2 = {$: "Con", "head": _a_0, "tail": _done_0};
          continue;
        }
      }
    }
  }
}

function $merge_at$(_ps_0, _k_0) {
  return $merge_at$go$(_ps_0, _k_0, {$: "Nil"});
}

function $step$merge$(_ps_0, _b_0) {
  if (_b_0.$ === "None") {
    return {$: "Stop", "ps": _ps_0};
  } else {
    const _t_0 = _b_0["value"];
    const _k_0 = _t_0["k"];
    return {$: "More", "ps": ($merge_at$(_ps_0, _k_0))};
  }
}

function $step$over$(_over_0, _T_0, _ps_0) {
  if (!_over_0) {
    return {$: "Stop", "ps": _ps_0};
  } else {
    return $step$merge$(_ps_0, ($best$(_T_0, _ps_0)));
  }
}

function $step$(_T_0, _budget_0, _ps_0) {
  return $step$over$(($Nat$is_gt$(($size$(_ps_0)), _budget_0)), _T_0, _ps_0);
}

function $fit$go$($0, $1, $2, $3) {
  for (;;) {
    {
      const _fuel_0 = $0;
      const _st_0 = $1;
      const _T_0 = $2;
      const _budget_0 = $3;
      if (_fuel_0 === 0) {
        if (_st_0.$ === "More") {
          const _ps_0 = _st_0["ps"];
          return _ps_0;
        } else {
          const _ps_1 = _st_0["ps"];
          return _ps_1;
        }
      } else {
        const _f_0 = (_fuel_0 - 1);
        if (_st_0.$ === "Stop") {
          const _ps_2 = _st_0["ps"];
          return _ps_2;
        } else {
          const _ps_3 = _st_0["ps"];
          $0 = _f_0;
          $1 = ($step$(_T_0, _budget_0, _ps_3));
          $2 = _T_0;
          $3 = _budget_0;
          continue;
        }
      }
    }
  }
}

function $length$($0, $1) {
  for (;;) {
    {
      const _ps_0 = $0;
      const _acc_0 = $1;
      if (_ps_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _rest_0 = _ps_0["tail"];
        $0 = _rest_0;
        $1 = nat_chk(_acc_0 + 1);
        continue;
      }
    }
  }
}

function $fit$(_T_0, _budget_0, _ps_0) {
  return $fit$go$(nat_chk(($length$(_ps_0, 0)) + 1), {$: "More", "ps": _ps_0}, _T_0, _budget_0);
}

function $snoc$(_ps_0, _p_0) {
  return $rev_onto$(($rev_onto$(_ps_0, {$: "Nil"})), {$: "Con", "head": _p_0, "tail": {$: "Nil"}});
}

function $append$(_T_0, _budget_0, _ps_0, _m_0) {
  const _s_0 = _m_0["size"];
  const _b_0 = _m_0["built"];
  const _ups_0 = _m_0["ups"];
  return $fit$(nat_chk(_T_0 + 1), _budget_0, ($snoc$(_ps_0, {$: "Part", "l": 0, "i": _T_0, "size": _s_0, "built": _b_0, "ups": _ups_0})));
}

function $pairs_with$(_rev_0, _p_0) {
  if (_rev_0.$ === "Nil") {
    return false;
  } else {
    const _q_0 = _rev_0["head"];
    return $mergeable$(_q_0, _p_0);
  }
}

function $fold$fit$(_T_0, _budget_0, _ps_0) {
  const _fitted_0 = ($fit$(_T_0, _budget_0, _ps_0));
  const _n_0 = ($size$(_fitted_0));
  return {$: "Fold", "rev": ($rev_onto$(_fitted_0, {$: "Nil"})), "size": _n_0, "stuck": ($Nat$is_gt$(_n_0, _budget_0))};
}

function $fold$decide$(_fits_0, _T_0, _budget_0, _rev_0, _n_0, _stuck_0) {
  if (_fits_0) {
    return {$: "Fold", "rev": _rev_0, "size": _n_0, "stuck": _stuck_0};
  } else {
    return $fold$fit$(_T_0, _budget_0, ($rev_onto$(_rev_0, {$: "Nil"})));
  }
}

function $fold$push$(_T_0, _budget_0, _f_0, _m_0) {
  const _rev_0 = _f_0["rev"];
  const _n_0 = _f_0["size"];
  const _stuck_0 = _f_0["stuck"];
  const _s_0 = _m_0["size"];
  const _b_0 = _m_0["built"];
  const _ups_0 = _m_0["ups"];
  const _p_0 = {$: "Part", "l": 0, "i": _T_0, "size": _s_0, "built": _b_0, "ups": _ups_0};
  const _stuck2_0 = ($Bool$and$(_stuck_0, ($Bool$not$(($pairs_with$(_rev_0, _p_0))))));
  const _n2_0 = nat_chk(_n_0 + _s_0);
  const _x_0 = ($Nat$is_le$(_n2_0, _budget_0));
  return $fold$decide$((_x_0 || _stuck2_0), nat_chk(_T_0 + 1), _budget_0, {$: "Con", "head": _p_0, "tail": _rev_0}, _n2_0, _stuck2_0);
}

function $refold$go$($0, $1, $2, $3) {
  for (;;) {
    {
      const _ms_0 = $0;
      const _budget_0 = $1;
      const _T_0 = $2;
      const _f_0 = $3;
      if (_ms_0.$ === "Nil") {
        return _f_0;
      } else {
        const _m_0 = _ms_0["head"];
        const _rest_0 = _ms_0["tail"];
        $0 = _rest_0;
        $1 = _budget_0;
        $2 = nat_chk(_T_0 + 1);
        $3 = ($fold$push$(_T_0, _budget_0, _f_0, _m_0));
        continue;
      }
    }
  }
}

function $refold$end$(_f_0) {
  const _rev_0 = _f_0["rev"];
  return $rev_onto$(_rev_0, {$: "Nil"});
}

function $refold$(_budget_0, _ms_0) {
  return $refold$end$(($refold$go$(_ms_0, _budget_0, 0, {$: "Fold", "rev": {$: "Nil"}, "size": 0, "stuck": true})));
}

function $first$unbuilt$(_b_0, _s_0) {
  if (_b_0) {
    return {$: "None"};
  } else {
    return {$: "Some", "value": _s_0};
  }
}

function $first$or$(_found_0, _T_0) {
  if (_found_0.$ === "Some") {
    const _x_0 = _found_0["value"];
    return _x_0;
  } else {
    return _T_0;
  }
}

function $first$keep$(_found_0, _p_0) {
  if (_found_0.$ === "Some") {
    const _x_0 = _found_0["value"];
    return {$: "Some", "value": _x_0};
  } else {
    const _l_0 = _p_0["l"];
    const _i_0 = _p_0["i"];
    const _b_0 = _p_0["built"];
    return $first$unbuilt$(_b_0, ($start$(_l_0, _i_0)));
  }
}

function $first$go$($0, $1, $2) {
  for (;;) {
    {
      const _ps_0 = $0;
      const _T_0 = $1;
      const _found_0 = $2;
      if (_ps_0.$ === "Nil") {
        return $first$or$(_found_0, _T_0);
      } else {
        const _p_0 = _ps_0["head"];
        const _rest_0 = _ps_0["tail"];
        $0 = _rest_0;
        $1 = _T_0;
        $2 = ($first$keep$(_found_0, _p_0));
        continue;
      }
    }
  }
}

function $first$(_T_0, _ps_0) {
  return $first$go$(_ps_0, _T_0, {$: "None"});
}

function $offer$(_ok_0, _c_0, _acc_0) {
  if (_ok_0) {
    return {$: "Con", "head": _c_0, "tail": _acc_0};
  } else {
    return _acc_0;
  }
}

function $offers$leaves$($0, $1, $2, $3) {
  for (;;) {
    {
      const _bs_0 = $0;
      const _head_0 = $1;
      const _i_0 = $2;
      const _acc_0 = $3;
      if (_bs_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _b_0 = _bs_0["head"];
        const _rest_0 = _bs_0["tail"];
        $0 = _rest_0;
        $1 = _head_0;
        $2 = nat_chk(_i_0 + 1);
        $3 = ($offer$(($Bool$and$(($Bool$not$(_b_0)), ($Nat$is_le$(_i_0, _head_0)))), {$: "Coord", "l": 0, "i": _i_0}, _acc_0));
        continue;
      }
    }
  }
}

function $offers$node$(_l_0, _head_0, _j_0, _b_0, _kids_0) {
  if (_kids_0.$ === "Nil") {
    return false;
  } else {
    const _x_0 = _kids_0["head"];
    const _t_0 = _kids_0["tail"];
    if (_t_0.$ === "Nil") {
      return false;
    } else {
      const _y_0 = _t_0["head"];
      return $Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$(_b_0)), _x_0)), _y_0)), ($Nat$is_le$(($start$(_l_0, nat_chk(_j_0 + 1))), _head_0)));
    }
  }
}

function $offers$drop2$(_kids_0) {
  if (_kids_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _kids_0["tail"];
    if (_t_0.$ === "Nil") {
      return {$: "Nil"};
    } else {
      const _rest_0 = _t_0["tail"];
      return _rest_0;
    }
  }
}

function $offers$level$($0, $1, $2, $3, $4, $5) {
  for (;;) {
    {
      const _own_0 = $0;
      const _kids_0 = $1;
      const _l_0 = $2;
      const _head_0 = $3;
      const _j_0 = $4;
      const _acc_0 = $5;
      if (_own_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _b_0 = _own_0["head"];
        const _rest_0 = _own_0["tail"];
        $0 = _rest_0;
        $1 = ($offers$drop2$(_kids_0));
        $2 = _l_0;
        $3 = _head_0;
        $4 = nat_chk(_j_0 + 1);
        $5 = ($offer$(($offers$node$(_l_0, _head_0, _j_0, _b_0, _kids_0)), {$: "Coord", "l": _l_0, "i": _j_0}, _acc_0));
        continue;
      }
    }
  }
}

function $offers$up$($0, $1, $2, $3, $4) {
  for (;;) {
    {
      const _levels_0 = $0;
      const _below_0 = $1;
      const _l_0 = $2;
      const _head_0 = $3;
      const _acc_0 = $4;
      if (_levels_0.$ === "Nil") {
        return _acc_0;
      } else {
        const _own_0 = _levels_0["head"];
        const _rest_0 = _levels_0["tail"];
        $0 = _rest_0;
        $1 = _own_0;
        $2 = nat_chk(_l_0 + 1);
        $3 = _head_0;
        $4 = ($offers$level$(_own_0, _below_0, _l_0, _head_0, 0, _acc_0));
        continue;
      }
    }
  }
}

function $offers$(_levels_0, _head_0) {
  if (_levels_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _leaves_0 = _levels_0["head"];
    const _rest_0 = _levels_0["tail"];
    return $offers$up$(_rest_0, _leaves_0, 1, _head_0, ($offers$leaves$(_leaves_0, _head_0, 0, {$: "Nil"})));
  }
}

function $Nat$div$(_a_0, _b_0) {
  return $Pair$fst$(nat_divmod(_a_0, _b_0));
}

function $Bool$and$(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Nat$is_eq$(_a_0, _b_0) {
  return $Cmp$is_eq$(cmp_new(_a_0, _b_0));
}

function $Nat$is_le$(_a_0, _b_0) {
  return $Cmp$is_le$(cmp_new(_a_0, _b_0));
}

function $Nat$is_gt$(_a_0, _b_0) {
  return $Cmp$is_gt$(cmp_new(_a_0, _b_0));
}

function $Bool$not$(_b_0) {
  if (!_b_0) {
    return true;
  } else {
    return false;
  }
}

function $Pair$fst$(_p_0) {
  const _a_0 = _p_0["fst"];
  return _a_0;
}

function $Cmp$is_eq$(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
  }
}

function $Cmp$is_le$(_c_0) {
  if (_c_0.$ === "GT") {
    return false;
  } else {
    return true;
  }
}

function $Cmp$is_gt$(_c_0) {
  if (_c_0.$ === "GT") {
    return true;
  } else {
    return false;
  }
}

function $0m0(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Below": at = at[key] = {...v, "l": BigInt(v["l"])}; return top[0];
      case "Found": at = at[key] = {...v, "l": BigInt(v["l"])}; return top[0];
      case "Past": at[key] = v; return top[0];
      default: throw "bend: Search has no tag " + v?.$ + " (its tags: Below, Found, Past); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m1(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Below": at = at[key] = {...v, "l": nat_host(v["l"])}; return top[0];
      case "Found": at = at[key] = {...v, "l": nat_host(v["l"])}; return top[0];
      case "Past": at[key] = v; return top[0];
      default: throw "bend: Search has no tag " + v?.$ + " (its tags: Below, Found, Past); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m2(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": BigInt(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m4(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Coord": at = at[key] = {...v, "l": BigInt(v["l"]), "i": BigInt(v["i"])}; return top[0];
      default: throw "bend: Coord has no tag " + v?.$ + " (its tags: Coord); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m3(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m4(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m5(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": nat_host(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m8(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": nat_host(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m7(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Part": at = at[key] = {...v, "l": nat_host(v["l"]), "i": nat_host(v["i"]), "size": nat_host(v["size"]), "ups": $0m8(v["ups"])}; return top[0];
      default: throw "bend: Part has no tag " + v?.$ + " (its tags: Part); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m6(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m7(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m11(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": BigInt(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m10(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Part": at = at[key] = {...v, "l": BigInt(v["l"]), "i": BigInt(v["i"]), "size": BigInt(v["size"]), "ups": $0m11(v["ups"])}; return top[0];
      default: throw "bend: Part has no tag " + v?.$ + " (its tags: Part); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m9(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m10(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m12(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Best": at = at[key] = {...v, "k": nat_host(v["k"]), "e": nat_host(v["e"]), "l": nat_host(v["l"])}; return top[0];
      default: throw "bend: Best has no tag " + v?.$ + " (its tags: Best); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m13(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Best": at = at[key] = {...v, "k": BigInt(v["k"]), "e": BigInt(v["e"]), "l": BigInt(v["l"])}; return top[0];
      default: throw "bend: Best has no tag " + v?.$ + " (its tags: Best); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m14(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m13(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m15(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m12(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m16(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "More": at = at[key] = {...v, "ps": $0m9(v["ps"])}; return top[0];
      case "Stop": at = at[key] = {...v, "ps": $0m9(v["ps"])}; return top[0];
      default: throw "bend: Step has no tag " + v?.$ + " (its tags: More, Stop); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m17(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "More": at = at[key] = {...v, "ps": $0m6(v["ps"])}; return top[0];
      case "Stop": at = at[key] = {...v, "ps": $0m6(v["ps"])}; return top[0];
      default: throw "bend: Step has no tag " + v?.$ + " (its tags: More, Stop); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m18(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Msg": at = at[key] = {...v, "size": nat_host(v["size"]), "ups": $0m8(v["ups"])}; return top[0];
      default: throw "bend: Msg has no tag " + v?.$ + " (its tags: Msg); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m19(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Msg": at = at[key] = {...v, "size": BigInt(v["size"]), "ups": $0m11(v["ups"])}; return top[0];
      default: throw "bend: Msg has no tag " + v?.$ + " (its tags: Msg); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m20(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Fold": at = at[key] = {...v, "rev": $0m9(v["rev"]), "size": BigInt(v["size"])}; return top[0];
      default: throw "bend: Fold has no tag " + v?.$ + " (its tags: Fold); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m21(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Fold": at = at[key] = {...v, "rev": $0m6(v["rev"]), "size": nat_host(v["size"])}; return top[0];
      default: throw "bend: Fold has no tag " + v?.$ + " (its tags: Fold); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m22(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m18(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m23(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m19(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m24(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Coord": at = at[key] = {...v, "l": nat_host(v["l"]), "i": nat_host(v["i"])}; return top[0];
      default: throw "bend: Coord has no tag " + v?.$ + " (its tags: Coord); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m25(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m24(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m26(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m4(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}
export default {
  "pow2": run_lib((a0) => { const r = BigInt(run_loop($pow2$(nat_host(a0)))); BigInt(a0); return r; }, 1),
  "start": run_lib((a0, a1) => { const r = BigInt(run_loop($start$(nat_host(a0), nat_host(a1)))); BigInt(a0); BigInt(a1); return r; }, 2),
  "log2.step": run_lib((a0, a1) => { const r = $0m0(run_loop($log2$step$((a0), nat_host(a1)))); (a0); BigInt(a1); return r; }, 2),
  "log2.done": run_lib((a0) => { const r = $0m2(run_loop($log2$done$($0m1(a0)))); $0m0(a0); return r; }, 1),
  "log2": run_lib((a0, a1, a2) => { const r = $0m2(run_loop($log2$(nat_host(a0), $0m1(a1), nat_host(a2)))); BigInt(a0); $0m0(a1); BigInt(a2); return r; }, 3),
  "coords.check": run_lib((a0, a1, a2) => { const r = $0m3(run_loop($coords$check$((a0), nat_host(a1), nat_host(a2)))); (a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "coords.at": run_lib((a0, a1, a2, a3) => { const r = $0m3(run_loop($coords$at$(nat_host(a0), nat_host(a1), nat_host(a2), $0m5(a3)))); BigInt(a0); BigInt(a1); BigInt(a2); $0m2(a3); return r; }, 4),
  "coords": run_lib((a0, a1, a2) => { const r = $0m3(run_loop($coords$(nat_host(a0), nat_host(a1), nat_host(a2)))); BigInt(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "rev_onto": run_lib((a0, a1) => { const r = $0m9(run_loop($rev_onto$($0m6(a0), $0m6(a1)))); $0m9(a0); $0m9(a1); return r; }, 2),
  "total": run_lib((a0, a1) => { const r = BigInt(run_loop($total$($0m6(a0), nat_host(a1)))); $0m9(a0); BigInt(a1); return r; }, 2),
  "size": run_lib((a0) => { const r = BigInt(run_loop($size$($0m6(a0)))); $0m9(a0); return r; }, 1),
  "built_up": run_lib((a0) => { const r = (run_loop($built_up$($0m8(a0)))); $0m11(a0); return r; }, 1),
  "mergeable": run_lib((a0, a1) => { const r = (run_loop($mergeable$($0m7(a0), $0m7(a1)))); $0m10(a0); $0m10(a1); return r; }, 2),
  "parent": run_lib((a0) => { const r = $0m10(run_loop($parent$($0m7(a0)))); $0m10(a0); return r; }, 1),
  "more_due": run_lib((a0, a1, a2) => { const r = (run_loop($more_due$(nat_host(a0), $0m12(a1), $0m12(a2)))); BigInt(a0); $0m13(a1); $0m13(a2); return r; }, 3),
  "choose.vs": run_lib((a0, a1, a2) => { const r = $0m14(run_loop($choose$vs$((a0), $0m12(a1), $0m12(a2)))); (a0); $0m13(a1); $0m13(a2); return r; }, 3),
  "choose": run_lib((a0, a1, a2, a3) => { const r = $0m14(run_loop($choose$(nat_host(a0), (a1), $0m12(a2), $0m15(a3)))); BigInt(a0); (a1); $0m13(a2); $0m14(a3); return r; }, 4),
  "pick": run_lib((a0, a1, a2, a3, a4) => { const r = $0m14(run_loop($pick$(nat_host(a0), $0m7(a1), $0m7(a2), nat_host(a3), $0m15(a4)))); BigInt(a0); $0m10(a1); $0m10(a2); BigInt(a3); $0m14(a4); return r; }, 5),
  "best.go": run_lib((a0, a1, a2, a3) => { const r = $0m14(run_loop($best$go$($0m6(a0), nat_host(a1), nat_host(a2), $0m15(a3)))); $0m9(a0); BigInt(a1); BigInt(a2); $0m14(a3); return r; }, 4),
  "best": run_lib((a0, a1) => { const r = $0m14(run_loop($best$(nat_host(a0), $0m6(a1)))); BigInt(a0); $0m9(a1); return r; }, 2),
  "merge_head": run_lib((a0, a1) => { const r = $0m9(run_loop($merge_head$($0m7(a0), $0m6(a1)))); $0m10(a0); $0m9(a1); return r; }, 2),
  "merge_at.go": run_lib((a0, a1, a2) => { const r = $0m9(run_loop($merge_at$go$($0m6(a0), nat_host(a1), $0m6(a2)))); $0m9(a0); BigInt(a1); $0m9(a2); return r; }, 3),
  "merge_at": run_lib((a0, a1) => { const r = $0m9(run_loop($merge_at$($0m6(a0), nat_host(a1)))); $0m9(a0); BigInt(a1); return r; }, 2),
  "step.merge": run_lib((a0, a1) => { const r = $0m16(run_loop($step$merge$($0m6(a0), $0m15(a1)))); $0m9(a0); $0m14(a1); return r; }, 2),
  "step.over": run_lib((a0, a1, a2) => { const r = $0m16(run_loop($step$over$((a0), nat_host(a1), $0m6(a2)))); (a0); BigInt(a1); $0m9(a2); return r; }, 3),
  "step": run_lib((a0, a1, a2) => { const r = $0m16(run_loop($step$(nat_host(a0), nat_host(a1), $0m6(a2)))); BigInt(a0); BigInt(a1); $0m9(a2); return r; }, 3),
  "fit.go": run_lib((a0, a1, a2, a3) => { const r = $0m9(run_loop($fit$go$(nat_host(a0), $0m17(a1), nat_host(a2), nat_host(a3)))); BigInt(a0); $0m16(a1); BigInt(a2); BigInt(a3); return r; }, 4),
  "length": run_lib((a0, a1) => { const r = BigInt(run_loop($length$($0m6(a0), nat_host(a1)))); $0m9(a0); BigInt(a1); return r; }, 2),
  "fit": run_lib((a0, a1, a2) => { const r = $0m9(run_loop($fit$(nat_host(a0), nat_host(a1), $0m6(a2)))); BigInt(a0); BigInt(a1); $0m9(a2); return r; }, 3),
  "snoc": run_lib((a0, a1) => { const r = $0m9(run_loop($snoc$($0m6(a0), $0m7(a1)))); $0m9(a0); $0m10(a1); return r; }, 2),
  "append": run_lib((a0, a1, a2, a3) => { const r = $0m9(run_loop($append$(nat_host(a0), nat_host(a1), $0m6(a2), $0m18(a3)))); BigInt(a0); BigInt(a1); $0m9(a2); $0m19(a3); return r; }, 4),
  "pairs_with": run_lib((a0, a1) => { const r = (run_loop($pairs_with$($0m6(a0), $0m7(a1)))); $0m9(a0); $0m10(a1); return r; }, 2),
  "fold.fit": run_lib((a0, a1, a2) => { const r = $0m20(run_loop($fold$fit$(nat_host(a0), nat_host(a1), $0m6(a2)))); BigInt(a0); BigInt(a1); $0m9(a2); return r; }, 3),
  "fold.decide": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m20(run_loop($fold$decide$((a0), nat_host(a1), nat_host(a2), $0m6(a3), nat_host(a4), (a5)))); (a0); BigInt(a1); BigInt(a2); $0m9(a3); BigInt(a4); (a5); return r; }, 6),
  "fold.push": run_lib((a0, a1, a2, a3) => { const r = $0m20(run_loop($fold$push$(nat_host(a0), nat_host(a1), $0m21(a2), $0m18(a3)))); BigInt(a0); BigInt(a1); $0m20(a2); $0m19(a3); return r; }, 4),
  "refold.go": run_lib((a0, a1, a2, a3) => { const r = $0m20(run_loop($refold$go$($0m22(a0), nat_host(a1), nat_host(a2), $0m21(a3)))); $0m23(a0); BigInt(a1); BigInt(a2); $0m20(a3); return r; }, 4),
  "refold.end": run_lib((a0) => { const r = $0m9(run_loop($refold$end$($0m21(a0)))); $0m20(a0); return r; }, 1),
  "refold": run_lib((a0, a1) => { const r = $0m9(run_loop($refold$(nat_host(a0), $0m22(a1)))); BigInt(a0); $0m23(a1); return r; }, 2),
  "first.unbuilt": run_lib((a0, a1) => { const r = $0m2(run_loop($first$unbuilt$((a0), nat_host(a1)))); (a0); BigInt(a1); return r; }, 2),
  "first.or": run_lib((a0, a1) => { const r = BigInt(run_loop($first$or$($0m5(a0), nat_host(a1)))); $0m2(a0); BigInt(a1); return r; }, 2),
  "first.keep": run_lib((a0, a1) => { const r = $0m2(run_loop($first$keep$($0m5(a0), $0m7(a1)))); $0m2(a0); $0m10(a1); return r; }, 2),
  "first.go": run_lib((a0, a1, a2) => { const r = BigInt(run_loop($first$go$($0m6(a0), nat_host(a1), $0m5(a2)))); $0m9(a0); BigInt(a1); $0m2(a2); return r; }, 3),
  "first": run_lib((a0, a1) => { const r = BigInt(run_loop($first$(nat_host(a0), $0m6(a1)))); BigInt(a0); $0m9(a1); return r; }, 2),
  "offer": run_lib((a0, a1, a2) => { const r = $0m26(run_loop($offer$((a0), $0m24(a1), $0m25(a2)))); (a0); $0m4(a1); $0m26(a2); return r; }, 3),
  "offers.leaves": run_lib((a0, a1, a2, a3) => { const r = $0m26(run_loop($offers$leaves$((a0), nat_host(a1), nat_host(a2), $0m25(a3)))); (a0); BigInt(a1); BigInt(a2); $0m26(a3); return r; }, 4),
  "offers.node": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($offers$node$(nat_host(a0), nat_host(a1), nat_host(a2), (a3), (a4)))); BigInt(a0); BigInt(a1); BigInt(a2); (a3); (a4); return r; }, 5),
  "offers.drop2": run_lib((a0) => { const r = (run_loop($offers$drop2$((a0)))); (a0); return r; }, 1),
  "offers.level": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m26(run_loop($offers$level$((a0), (a1), nat_host(a2), nat_host(a3), nat_host(a4), $0m25(a5)))); (a0); (a1); BigInt(a2); BigInt(a3); BigInt(a4); $0m26(a5); return r; }, 6),
  "offers.up": run_lib((a0, a1, a2, a3, a4) => { const r = $0m26(run_loop($offers$up$((a0), (a1), nat_host(a2), nat_host(a3), $0m25(a4)))); (a0); (a1); BigInt(a2); BigInt(a3); $0m26(a4); return r; }, 5),
  "offers": run_lib((a0, a1) => { const r = $0m26(run_loop($offers$((a0), nat_host(a1)))); (a0); BigInt(a1); return r; }, 2),
};
