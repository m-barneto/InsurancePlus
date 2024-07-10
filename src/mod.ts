import { DependencyContainer } from "tsyringe";
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { InraidControllerExtension } from "./InraidControllerExtension";
import { ILogger } from "@spt/models/spt/utils/ILogger";

class Mod implements IPreSptLoadMod {

    preSptLoad(container: DependencyContainer): void {
        const logger = container.resolve<ILogger>("WinstonLogger");
        container.register<InraidControllerExtension>("InraidControllerExtension", InraidControllerExtension);
        container.register("InraidController", { useToken: "InraidControllerExtension" });
    }
}

export const mod = new Mod();
