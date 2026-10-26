import { Header } from '@/header/header';
import { Scene } from '@/scene/scene';
import { Workbench } from '@/workbench/workbench';

export function App() {
	return (
		<div className="flex min-h-screen flex-col">
			<Header />
			<main className="grid grow grid-cols-1 gap-4 p-3 sm:p-4 lg:gap-5 lg:p-5 xl:grid-cols-12">
				<div className="flex min-h-[640px] min-w-0 xl:col-span-5 xl:min-h-[calc(100vh-6rem)]">
					<Workbench />
				</div>
				<div className="flex min-w-0 xl:col-span-7">
					<Scene />
				</div>
			</main>
		</div>
	);
}
