/** 11. 算出方法と限界 */
export default function Methodology() {
  return (
    <details className="group min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="cursor-pointer select-none px-3 py-3 text-sm font-bold text-slate-900 sm:px-4">
        📘 算出方法と限界
      </summary>
      <div className="space-y-3 border-t border-slate-100 p-3 text-xs leading-relaxed text-slate-700 sm:p-4">
        <section>
          <h4 className="font-bold text-slate-800">価格の式</h4>
          <p className="mt-1 rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[11px]">
            P = clamp(round(P_base × (1+δ) × (1+α) × (1+β) × (1+γ)), 下限, 上限)
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>δ 曜日属性: 週末・特定連休のプレミアム。既定は CompSet の同一物件内の 週末/平日・連休/平日 価格比から自動測定（測定不能時は設定値）。</li>
            <li>α 競合占有率: 80%以上で +15〜25%、50〜80%で +5〜10%、30%未満かつ14日以内で −10〜20%。範囲内は線形補間（区分別に設定可）。</li>
            <li>β 消化ペース: 予約曲線から期待される通常の積み増しを超えて予約が急増した日は +5〜15%、停滞は最大 −5%。</li>
            <li>γ リードタイム: 7日以内の未稼働は段階的に値下げ（平日最大 −25%、週末最大 −10%）。競合が逼迫している夜は値下げを縮小。45日以上先は早期確約ディスカウントまたは先行高値。</li>
            <li>ガードレール: 平日・週末別の下限と、エリア受容上限で異常値を抑えます。</li>
          </ul>
        </section>
        <section>
          <h4 className="font-bold text-slate-800">競合セット（CompSet）</h4>
          <p className="mt-1">
            半径 7km・一棟貸し・ADR ±30%・定員 6〜10名・評価 4.7以上・レビュー 5件以上。実データでは厳格条件で数件にとどまるため、
            最小件数を下回ると ADR帯 → 定員 → 評価/レビュー の順に段階的に緩和し、緩和内容を表示します。一棟貸しは AirROI の room_type で判定します。
          </p>
        </section>
        <section>
          <h4 className="font-bold text-slate-800">占有率の補正</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>ブロック補正: AirROI の将来カレンダーは「予約済」と「ホストのブロック」を区別しないため、物件ごとの過去12ヶ月の 予約日/(予約日+ブロック日) で予約分を推定します（= 有効競合総室数）。</li>
            <li>縮小推定: 物件数が少ないと1件の予約で占有率が大きく動くため、同区分・近いリードタイムの日の情報を借りる empirical Bayes で安定化し、80%信用区間を併記します。</li>
            <li>鮮度: カレンダーの最終取得成功日で判定し、直前の日ほど新しい観測を要求します。取得失敗を繰り返す物件は再取得しません。</li>
          </ul>
        </section>
        <section>
          <h4 className="font-bold text-slate-800">超過 Pace と予約曲線</h4>
          <p className="mt-1">
            当日に近づけば自然に埋まるため、Pace は過去のスナップショットとの差分から「予約曲線で期待される通常の積み増し」を差し引いた超過分（pt/7日）です。
            要注意日（⚡）は超過 Pace に加えて新規予約が2件以上あることを条件にしています。予約曲線は各宿泊日のリードタイム別占有率を平均し単調化したものです。
          </p>
        </section>
        <section>
          <h4 className="font-bold text-slate-800">売上シミュレーションの前提</h4>
          <p className="mt-1">
            予約曲線から残り在庫の成約確率を求め、需要の価格弾力性で価格の影響を見積もります。
            <span className="font-semibold">弾力性は実測ではなく仮定</span>
            であり、結果の符号まで変わりうるため、3つのシナリオと損益分岐の弾力性を併記しています。参照価格は自社の品質プレミアムを保った市場連動価格です。
            Airbnb の設定価格を入力していない場合は「固定シーズン料金（基準価格×週末係数）」との比較になります。
          </p>
        </section>
        <section>
          <h4 className="font-bold text-slate-800">限界</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>自社（Lumina）は AirROI 未収録のため、予約状況は iCal 取り込みか手動指定、現在価格は設定画面の入力値です。未入力の現在価格は「仮」と表示し、乖離率や値上げ/値下げ判定には使いません。</li>
            <li>Airbnb には価格の CSV 一括取り込み機能がありません。「推奨価格の反映」の一覧を見て Airbnb アプリで入力してください（CSV は表計算・チャネルマネージャ用）。</li>
            <li>競合カレンダーの取得は有料（$0.10/件）です。自動取得は既定でオフで、取得ボタンは確認ダイアログに件数と費用を表示します。</li>
          </ul>
        </section>
      </div>
    </details>
  );
}
