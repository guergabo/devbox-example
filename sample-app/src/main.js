import "./style.css";
import { addTodo, remainingCount, toggleTodo } from "./todos.js";

let todos = [];

const form = document.querySelector("#new-todo");
const input = document.querySelector("#new-todo input");
const list = document.querySelector("#todos");
const counter = document.querySelector("#remaining");

function render() {
	list.replaceChildren(
		...todos.map((todo) => {
			const item = document.createElement("li");
			item.textContent = todo.text;
			item.className = todo.done ? "done" : "";
			item.addEventListener("click", () => {
				todos = toggleTodo(todos, todo.id);
				render();
			});
			return item;
		}),
	);
	counter.textContent = `${remainingCount(todos)} left`;
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	todos = addTodo(todos, input.value);
	input.value = "";
	render();
});

render();
