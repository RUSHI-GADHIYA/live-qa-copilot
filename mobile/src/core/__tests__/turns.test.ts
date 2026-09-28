import { Conversation } from '../turns';

const ANSWER = 'The refund window is 45 days from delivery, and refunds go back to the original payment method.';

function withAnswer(): Conversation {
  const c = new Conversation();
  c.addQuestion(1, 'What is the refund window?');
  c.appendAnswer(1, ANSWER);
  return c;
}

describe('read-back filter', () => {
  it('catches the listener reading the answer aloud', () => {
    const c = withAnswer();
    expect(c.readbackScore('the refund window is 45 days from delivery')).toBe(1);
    expect(c.isReadback('so the refund window is 45 days from delivery and refunds go back')).toBe(true);
  });

  it('counts a partial answer while it is still streaming', () => {
    const c = new Conversation();
    c.addQuestion(1, 'q');
    c.appendAnswer(1, 'The refund window is 45 days');
    expect(c.isReadback('the refund window is 45 days')).toBe(true);
  });

  it('lets new questions that share words through', () => {
    const c = withAnswer();
    expect(c.isReadback('what is the refund window for exchanges')).toBe(false);
    expect(c.isReadback('you said 45 days from delivery, does that include weekends?')).toBe(false);
    expect(c.isReadback('how does photosynthesis work')).toBe(false);
  });

  it('counts fragments only when read word for word', () => {
    const c = withAnswer();
    expect(c.isReadback('The refund window.')).toBe(true);
    expect(c.isReadback('from delivery')).toBe(true);
    expect(c.isReadback("It's 45 days.")).toBe(false);
    expect(c.isReadback('what about exchanges')).toBe(false);
    expect(c.readbackScore('window')).toBe(0);
  });

  it('ignores citation markers', () => {
    const c = new Conversation();
    c.addQuestion(1, 'q');
    c.appendAnswer(1, 'I led the X7 integration team for four years [1] at Acme Robotics [2].');
    expect(c.readbackScore('I led the X7 integration team for four years at Acme Robotics')).toBe(1);
  });

  it('forgets answers older than three minutes', () => {
    let now = 0;
    const c = new Conversation(8, 4, () => now);
    c.addQuestion(1, 'q');
    c.appendAnswer(1, ANSWER);
    now = 181_000;
    expect(c.isReadback('the refund window is 45 days from delivery')).toBe(false);
  });
});

describe('history', () => {
  it('builds detector turns and answer messages', () => {
    const c = withAnswer();
    c.addOther('we should grab lunch');
    expect(c.detectorHistory()).toEqual([
      ['QUESTION', 'What is the refund window?'],
      ['SUGGESTED ANSWER', ANSWER],
      ['OTHER', 'we should grab lunch'],
    ]);
    c.addQuestion(2, 'And exchanges?');
    expect(c.answerHistory(2)).toEqual([
      { role: 'user', content: 'What is the refund window?' },
      { role: 'assistant', content: ANSWER },
    ]);
    expect(c.lastQuestionId).toBe(2);
  });

  it('evicts old exchanges', () => {
    const c = new Conversation(2);
    for (let i = 1; i <= 3; i++) {
      c.addQuestion(i, `q${i}`);
      c.appendAnswer(i, `a${i}`);
    }
    c.appendAnswer(1, 'late delta for an evicted question');
    expect(c.answerHistory().map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
  });
});
