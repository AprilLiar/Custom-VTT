import { useEffect, useState } from 'react';
import { socket } from '../socket.js';

// The 6 canonical questions. Answers are stored keyed by this exact text
// (is_custom = 0), so edit with care — rewording orphans old answers.
export const FIXED_QUESTIONS = [
  'What your character absolutely loves and cannot pass by on the street?',
  'What is their biggest traumatic event or memory?',
  'What is their irrational fear?',
  'What is their favorite food?',
  'Is there something another person can do, that will infuriate them?',
  'What is their biggest vice?',
];

const MAX_CUSTOM = 20;

function AnswerArea({ value, onSave }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      rows={2}
      placeholder="…"
      className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
    />
  );
}

export default function RoleplayTab({ data }) {
  const { character, roleplay } = data;
  const [newQuestion, setNewQuestion] = useState('');

  const fixedAnswers = new Map(
    roleplay.filter((e) => !e.is_custom).map((e) => [e.question, e])
  );
  const custom = roleplay.filter((e) => e.is_custom);

  const addQuestion = (e) => {
    e.preventDefault();
    if (!newQuestion.trim()) return;
    socket.emit('roleplay:add_question', {
      characterId: character.id,
      question: newQuestion.trim(),
    });
    setNewQuestion('');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      {FIXED_QUESTIONS.map((question) => (
        <div key={question}>
          <p className="mb-1 text-sm font-semibold text-zinc-300">{question}</p>
          <AnswerArea
            value={fixedAnswers.get(question)?.answer ?? ''}
            onSave={(answer) =>
              socket.emit('roleplay:save_answer', {
                characterId: character.id,
                question,
                answer,
              })
            }
          />
        </div>
      ))}

      {custom.map((entry) => (
        <div key={entry.id}>
          <div className="mb-1 flex items-center gap-2">
            <CustomQuestion entry={entry} />
            <button
              onClick={() =>
                window.confirm('Delete this question and its answer?') &&
                socket.emit('roleplay:delete_question', { entryId: entry.id })
              }
              title="Delete question"
              className="rounded px-1 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
            >
              ✕
            </button>
          </div>
          <AnswerArea
            value={entry.answer}
            onSave={(answer) =>
              socket.emit('roleplay:update_entry', {
                entryId: entry.id,
                question: entry.question,
                answer,
              })
            }
          />
        </div>
      ))}

      <form onSubmit={addQuestion} className="flex gap-2 border-t border-zinc-800 pt-3">
        <input
          value={newQuestion}
          onChange={(e) => setNewQuestion(e.target.value)}
          placeholder={
            custom.length >= MAX_CUSTOM
              ? `Limit of ${MAX_CUSTOM} additional questions reached`
              : 'Add your own question…'
          }
          disabled={custom.length >= MAX_CUSTOM}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!newQuestion.trim() || custom.length >= MAX_CUSTOM}
          className="rounded-md bg-indigo-600 px-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </div>
  );
}

function CustomQuestion({ entry }) {
  const [draft, setDraft] = useState(entry.question);
  useEffect(() => setDraft(entry.question), [entry.question]);
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() =>
        draft.trim() &&
        draft.trim() !== entry.question &&
        socket.emit('roleplay:update_entry', {
          entryId: entry.id,
          question: draft.trim(),
          answer: entry.answer,
        })
      }
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-sm font-semibold text-zinc-300 outline-none hover:border-zinc-700 focus:border-indigo-500"
    />
  );
}
