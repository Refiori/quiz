// Создаёт пример questions.xlsx: 15 тем × 5 уровней, у каждого уровня 3 варианта вопроса.
// Запуск: npm run sample   (существующий questions.xlsx будет перезаписан!)
const XLSX = require('xlsx');

const rows = [['Тема']];
for (let v = 1; v <= 3; v++) rows[0].push(`Вопрос ${v}`, `Ответ ${v}`);

for (let t = 1; t <= 15; t++) {
  for (let lvl = 1; lvl <= 5; lvl++) {
    const row = [`Тема ${t}`];
    for (let v = 1; v <= 3; v++) {
      row.push(`Тема ${t}, уровень ${lvl}, вариант ${v}: тестовый вопрос`, `Ответ ${t}-${lvl}-${v}`);
    }
    rows.push(row);
  }
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Вопросы');
XLSX.writeFile(wb, 'questions.xlsx');
console.log('Готово: создан файл questions.xlsx');
