import { Panel } from "../../components/Panel";

export function CardTitleEditor({ cardId }: { cardId: string }) {
	return (
		<RightPanel active>
			<form onSubmit={(e) => handleTitleEdit(e, cardId)}>
				<input name="title" />
			</form>
		</RightPanel>
	);
}

function handleTitleEdit(e: unknown, cardId: string) {
	// save
}

const RightPanel = Panel;
