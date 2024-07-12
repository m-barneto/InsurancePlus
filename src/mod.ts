import { DependencyContainer } from "tsyringe";
import { IPreAkiLoadMod } from "@spt-aki/models/external/IPreAkiLoadMod";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { InraidControllerExtension } from "./InraidControllerExtension";


class Mod implements IPreAkiLoadMod {

    preAkiLoad(container: DependencyContainer): void {
        const logger = container.resolve<ILogger>("WinstonLogger");
        container.register<InraidControllerExtension>("InraidControllerExtension", InraidControllerExtension);
        container.register("InraidController", { useToken: "InraidControllerExtension" });
    }
}

export const mod = new Mod();
