import { useState } from 'react';
import type { ChatChoices } from '@protea/protocol';
import { IconCheck } from '../icons';
import { cx } from '../ui';

/** `open`: the newest choices, not answered yet. `answered`: the owner chose. `closed`: the conversation moved on. */
export type ChoiceState = 'open' | 'answered' | 'closed';

/**
 * Options under a reply. Choosing one sends its label as the owner's message: the label is drawn
 * by this page, so what is on the button is what is sent.
 */
export function Choices({ choices, state, chosen, canAnswer, onChoose }: { choices: ChatChoices; state: ChoiceState; chosen: string[]; canAnswer: boolean; onChoose: (labels: string[]) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const open = state === 'open' && canAnswer && !busy;
  const send = (labels: string[]) => {
    setBusy(true);
    void onChoose(labels).finally(() => setBusy(false));
  };
  return (
    <div className={cx('choices', `choices-${state}`)} role="group" aria-label="选项">
      <div className="choices-list">
        {choices.options.map((o) => {
          const on = state === 'answered' ? chosen.includes(o.label) : picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              className={cx('choice', on && 'choice-on')}
              disabled={!open}
              aria-pressed={on}
              onClick={() => {
                if (choices.multiple) setPicked((old) => (old.includes(o.label) ? old.filter((l) => l !== o.label) : [...old, o.label]));
                else send([o.label]);
              }}
            >
              <span className="choice-label">
                {o.label}
                {on && <IconCheck size={14} />}
              </span>
              {o.detail && <span className="choice-detail">{o.detail}</span>}
            </button>
          );
        })}
      </div>
      <div className="choices-foot">
        {state === 'open' && choices.multiple && canAnswer && (
          <button type="button" className="btn btn-small btn-primary" disabled={busy || picked.length === 0} onClick={() => send(choices.options.map((o) => o.label).filter((l) => picked.includes(l)))}>
            发送所选
          </button>
        )}
        <span className="choices-hint">{state === 'open' ? (canAnswer ? (choices.multiple ? '可以多选，也可以直接输入' : '点一个选项，或者直接输入') : '只读账号不能回答') : state === 'answered' ? '已选择' : '已经不需要回答'}</span>
      </div>
    </div>
  );
}
