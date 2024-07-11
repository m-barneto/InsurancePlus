import { ApplicationContext } from "@spt/context/ApplicationContext";
import { InraidController } from "@spt/controllers/InraidController";
import { PlayerScavGenerator } from "@spt/generators/PlayerScavGenerator";
import { HealthHelper } from "@spt/helpers/HealthHelper";
import { InRaidHelper } from "@spt/helpers/InRaidHelper";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { NotificationSendHelper } from "@spt/helpers/NotificationSendHelper";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { QuestHelper } from "@spt/helpers/QuestHelper";
import { TraderHelper } from "@spt/helpers/TraderHelper";
import { ILocationBase } from "@spt/models/eft/common/ILocationBase";
import { IPmcData } from "@spt/models/eft/common/IPmcData";
import { InsuredItem } from "@spt/models/eft/common/tables/IBotBase";
import { Item } from "@spt/models/eft/common/tables/IItem";
import { ISaveProgressRequestData } from "@spt/models/eft/inRaid/ISaveProgressRequestData";
import { ItemTpl } from "@spt/models/enums/ItemTpl";
import { QuestStatus } from "@spt/models/enums/QuestStatus";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { SaveServer } from "@spt/servers/SaveServer";
import { DatabaseService } from "@spt/services/DatabaseService";
import { InsuranceService } from "@spt/services/InsuranceService";
import { LocalisationService } from "@spt/services/LocalisationService";
import { MailSendService } from "@spt/services/MailSendService";
import { MatchBotDetailsCacheService } from "@spt/services/MatchBotDetailsCacheService";
import { PmcChatResponseService } from "@spt/services/PmcChatResponseService";
import { TraderServicesService } from "@spt/services/TraderServicesService";
import { JsonUtil } from "@spt/utils/JsonUtil";
import { RandomUtil } from "@spt/utils/RandomUtil";
import { TimeUtil } from "@spt/utils/TimeUtil";
import { inject, injectable } from "tsyringe";


@injectable()
export class InraidControllerExtension extends InraidController {
    private config = require("../config/config.json");

    constructor(
        @inject("WinstonLogger") protected logger: ILogger,
        @inject("SaveServer") protected saveServer: SaveServer,
        @inject("JsonUtil") protected jsonUtil: JsonUtil,
        @inject("TimeUtil") protected timeUtil: TimeUtil,
        @inject("DatabaseService") protected databaseService: DatabaseService,
        @inject("TraderServicesService") protected traderServicesService: TraderServicesService, 
        @inject("LocalisationService") protected localisationService: LocalisationService,
        @inject("PmcChatResponseService") protected pmcChatResponseService: PmcChatResponseService,
        @inject("MatchBotDetailsCacheService") protected matchBotDetailsCacheService: MatchBotDetailsCacheService,
        @inject("QuestHelper") protected questHelper: QuestHelper,
        @inject("ItemHelper") protected itemHelper: ItemHelper,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("PlayerScavGenerator") protected playerScavGenerator: PlayerScavGenerator,
        @inject("NotificationSendHelper") protected notificationSendHelper: NotificationSendHelper,
        @inject("HealthHelper") protected healthHelper: HealthHelper,
        @inject("TraderHelper") protected traderHelper: TraderHelper,
        @inject("InsuranceService") protected insuranceService: InsuranceService,
        @inject("InRaidHelper") protected inRaidHelper: InRaidHelper,
        @inject("ApplicationContext") protected applicationContext: ApplicationContext,
        @inject("ConfigServer") protected configServer: ConfigServer,
        @inject("MailSendService") protected mailSendService: MailSendService,
        @inject("RandomUtil") randomUtil: RandomUtil
    ) {
        super(
            logger,
            saveServer,
            timeUtil,
            databaseService,
            pmcChatResponseService,
            matchBotDetailsCacheService,
            questHelper,
            itemHelper,
            profileHelper,
            playerScavGenerator,
            healthHelper,
            traderHelper,
            traderServicesService,
            localisationService,
            insuranceService,
            inRaidHelper,
            applicationContext,
            configServer,
            mailSendService,
            randomUtil
        );
    }

    /**
     * Handle updating player profile post-pmc raid
     * @param sessionID Session id
     * @param postRaidRequest Post-raid data
     */
    protected override savePmcProgress(sessionID: string, postRaidRequest: ISaveProgressRequestData): void {
        const serverProfile = this.saveServer.getProfile(sessionID);

        const locationName = serverProfile.inraid.location.toLowerCase();

        const map: ILocationBase = this.databaseService.getLocation(locationName).base;

        const serverPmcProfile = serverProfile.characters.pmc;
        const serverScavProfile = serverProfile.characters.scav;

        const isDead = this.isPlayerDead(postRaidRequest.exit);
        const preRaidGear = this.inRaidHelper.getPlayerGear(serverPmcProfile.Inventory.items);

        serverProfile.inraid.character = "pmc";

        this.inRaidHelper.updateProfileBaseStats(serverPmcProfile, postRaidRequest, sessionID);
        this.inRaidHelper.updatePmcProfileDataPostRaid(serverPmcProfile, postRaidRequest, sessionID);

        this.mergePmcAndScavEncyclopedias(serverPmcProfile, serverScavProfile);

        // Check for exit status
        this.markOrRemoveFoundInRaidItems(postRaidRequest);

        postRaidRequest.profile.Inventory.items = this.itemHelper.replaceIDs(
            postRaidRequest.profile.Inventory.items,
            postRaidRequest.profile,
            serverPmcProfile.InsuredItems,
            postRaidRequest.profile.Inventory.fastPanel
        );
        this.inRaidHelper.addStackCountToMoneyFromRaid(postRaidRequest.profile.Inventory.items);

        // Purge profile of equipment/container items
        this.inRaidHelper.setInventory(sessionID, serverPmcProfile, postRaidRequest.profile);

        this.healthHelper.saveVitality(serverPmcProfile, postRaidRequest.health, sessionID);

        // Get array of insured items+child that were lost in raid
        const gearToStore = this.insuranceService.getGearLostInRaid(
            serverPmcProfile,
            postRaidRequest,
            preRaidGear,
            sessionID,
            false
        );

        // Check if insurance fraud is allowed
        if (gearToStore.length > 0 && this.config.EnableDefaultInsurance) {
            this.insuranceService.storeGearLostInRaidToSendLater(sessionID, gearToStore);
        }

        // Edge case - Handle usec players leaving lighthouse with Rogues angry at them
        if (locationName === "lighthouse" && postRaidRequest.profile.Info.Side.toLowerCase() === "usec") {
            // Decrement counter if it exists, don't go below 0
            const remainingCounter = serverPmcProfile?.Stats.Eft.OverallCounters.Items.find((x) =>
                x.Key.includes("UsecRaidRemainKills")
            );
            if (remainingCounter?.Value > 0) {
                remainingCounter.Value--;
            }
        }

        if (isDead) {
            this.pmcChatResponseService.sendKillerResponse(
                sessionID,
                serverPmcProfile,
                postRaidRequest.profile.Stats.Eft.Aggressor
            );
            this.matchBotDetailsCacheService.clearCache();
            
            this.performPostRaidActionsWhenDead(postRaidRequest, serverPmcProfile, sessionID);
        } else {
            // Not dead

            // Check for cultist amulets in special slot (only slot it can fit)
            const sacredAmulet = this.itemHelper.getItemFromPoolByTpl(
                serverPmcProfile.Inventory.items,
                ItemTpl.CULTISTAMULET_SACRED_AMULET,
                "SpecialSlot");
            if (sacredAmulet) {
                // No charges left, delete it
                if (sacredAmulet.upd.CultistAmulet.NumberOfUsages <= 0) {
                    serverPmcProfile.Inventory.items.splice(
                        serverPmcProfile.Inventory.items.indexOf(sacredAmulet),
                        1
                    );
                } else if (sacredAmulet.upd.CultistAmulet.NumberOfUsages > 0) {
                    // Charges left, reduce by 1
                    sacredAmulet.upd.CultistAmulet.NumberOfUsages--;
                }
            }
        }

        const victims = postRaidRequest.profile.Stats.Eft.Victims.filter((victim) =>
            ["pmcbear", "pmcusec"].includes(victim.Role.toLowerCase())
        );
        if (victims?.length > 0) {
            this.pmcChatResponseService.sendVictimResponse(sessionID, victims, serverPmcProfile);
        }

        this.insuranceService.sendInsuredItems(serverPmcProfile, sessionID, map.Id);
    }

    /**
     * Make changes to PMC profile after they've died in raid,
     * Alter body part hp, handle insurance, delete inventory items, remove carried quest items
     * @param postRaidSaveRequest Post-raid save request
     * @param pmcData Pmc profile
     * @param sessionID Session id
     * @returns Updated profile object
     */
    protected override performPostRaidActionsWhenDead(postRaidSaveRequest: ISaveProgressRequestData, pmcData: IPmcData, sessionID: string): IPmcData {
        this.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);

        // replaced this
        // this.inRaidHelper.deleteInventory(pmcData, sessionID);
        this.deleteInventoryWithoutInsuranceItems(pmcData, sessionID);

        if (this.inRaidHelper.shouldQuestItemsBeRemovedOnDeath()) {
            // Find and remove the completed condition from profile if player died, otherwise quest is stuck in limbo
            // and quest items cannot be picked up again
            const allQuests = this.questHelper.getQuestsFromDb();
            const activeQuestIdsInProfile = pmcData.Quests.filter(
                (profileQuest) =>
                    ![QuestStatus.AvailableForStart, QuestStatus.Success, QuestStatus.Expired].includes(
                        profileQuest.status
                    )
            ).map((x) => x.qid);
            for (const questItem of postRaidSaveRequest.profile.Stats.Eft.CarriedQuestItems) {
            // Get quest/find condition for carried quest item
                const questAndFindItemConditionId = this.questHelper.getFindItemConditionByQuestItem(
                    questItem,
                    activeQuestIdsInProfile,
                    allQuests
                );
                if (Object.keys(questAndFindItemConditionId)?.length > 0) {
                    this.profileHelper.removeQuestConditionFromProfile(pmcData, questAndFindItemConditionId);
                }
            }

            // Empty out stored quest items from player inventory
            pmcData.Stats.Eft.CarriedQuestItems = [];
        }

        return pmcData;
    }

    public deleteInventoryWithoutInsuranceItems(pmcData: IPmcData, sessionID: string): void {
        const insuredItems = [];
        let deleteObj = {
            "DeleteItem": [],
            "DeleteInsurance": []
        };
        const dbParentIdsToCheck = [
            "5795f317245977243854e041",	// Container
            "5448e54d4bdc2dcc718b4568",	// Armor
            "5448e5284bdc2dcb718b4567",	// Vest
            "5448e53e4bdc2d60728b4567",	// Backpack
            "5a341c4086f77401f2541505",	// Headwear
            "5447bed64bdc2d97278b4568",	// Machine Guns
            "5447b6254bdc2dc3278b4568",	// Snipers Rifles
            "5447b5e04bdc2d62278b4567",	// Smgs
            "5447b6094bdc2dc3278b4567",	// Shotguns
            "5447b5cf4bdc2d65278b4567",	// Pistol
            "5447b6194bdc2d67278b4567",	// Marksman Rifles
            "5447b5f14bdc2d61278b4567",	// Assault Rifles
            "5447b5fc4bdc2d87278b4567",	// Assault Carbines
            "617f1ef5e8b54b0998387733"	// Revolvers
        ];
		
        // dump all insured items in a simple array
        for (const insItem of pmcData.InsuredItems) {
            insuredItems.push(insItem.itemId);
        }

        for (const item of pmcData.Inventory.items) {
            // loop through inventory items
            if (item.parentId === pmcData.Inventory.equipment) {
                // add equipped insured items to an insurance delete array
                if (insuredItems.includes(item._id)) {
                    deleteObj.DeleteInsurance.push(item._id);
                }
				
                // handle them pockets
                if (item.slotId.startsWith("Pockets")) {
                    deleteObj = this.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, deleteObj);
                }
				
                // push uninsured item to delete array
                if (!this.inRaidHelper["isItemKeptAfterDeath"](pmcData, item) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
                    deleteObj.DeleteItem.push(item._id);
                }
				
                // Remove items inside gear items
                if (item.slotId != "hideout" && item.slotId != "FirstPrimaryWeapon" && item.slotId != "SecondPrimaryWeapon" && item.slotId != "Holster" && !this.inRaidHelper["isItemKeptAfterDeath"](pmcData, item)) {
                    deleteObj = this.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, deleteObj);
                }
				
                // handle equipped guns, since we don't want want them becoming unoperable in player hands
                if (item.slotId === "FirstPrimaryWeapon" || item.slotId === "SecondPrimaryWeapon" || item.slotId === "Holster") {
                    deleteObj = this.handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, deleteObj);
                }
            }
        }
		
        // remove insurance from equipped items
        if (this.config.LoseInsuranceOnItemAfterDeath) {
            pmcData.InsuredItems = this.removeInsuredItems(pmcData.InsuredItems, deleteObj.DeleteInsurance)
        }

        // delete items
        const inventoryItems = pmcData.Inventory.items;
        for (const itemToDelete of deleteObj.DeleteItem) {
            if (inventoryItems.findIndex((item) => item._id === itemToDelete)) {
                this.inRaidHelper["inventoryHelper"].removeItem(pmcData, itemToDelete, sessionID);
            }
        }

        pmcData.Inventory.fastPanel = {};
    }

    public handleInventoryItems(pmcData: IPmcData, item: Item, insuredItems: string[], dbParentIdsToCheck: string[], returnObj: { DeleteInsurance: string[]; DeleteItem: string[]; }): { DeleteInsurance: string[]; DeleteItem: string[]; } {
        for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
            // Don't delete items in special slots
            // also skip insured items
            if (!itemInInventory.slotId.includes("SpecialSlot")) {
                // add equipped insured items to an insurance delete array
                if (insuredItems.includes(itemInInventory._id)) {
                    returnObj.DeleteInsurance.push(itemInInventory._id);
                }
				
                if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id) && !this.isRequiredArmorPlate(itemInInventory, item)) {
                    returnObj.DeleteItem.push(itemInInventory._id);
                } else if (dbParentIdsToCheck.includes(this.databaseService.getTemplates().items[itemInInventory._tpl]._parent)) {
                    returnObj = this.handleInventoryItems(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, returnObj)
                }
            }
        }
		
        return returnObj;
    }

    public handleEquippedGuns(pmcData: IPmcData, item: Item, insuredItems: string[], dbParentIdsToCheck: string[], returnObj: { DeleteInsurance: string[]; DeleteItem: string[]; }): { DeleteInsurance: string[]; DeleteItem: string[]; } {
        for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
            // skip if its ammo, we want to keep it
            if (this.databaseService.getTemplates().items[itemInInventory._tpl]._parent === "5485a8684bdc2da71d8b4567") {
                continue;
            }
			
            // add to insured array if insured
            if (insuredItems.includes(itemInInventory._id)) {
                returnObj.DeleteInsurance.push(itemInInventory._id);
            }
			
            if (this.databaseService.getTemplates().items[item._tpl]._props.Slots.length != 0) {
                for (const slotsIndex in this.databaseService.getTemplates().items[item._tpl]._props.Slots) {
                    if (this.databaseService.getTemplates().items[item._tpl]._props.Slots[slotsIndex]._props.filters[0].Filter.includes(itemInInventory._tpl)) {
						
                        // check if the item is required, like pistol grips, gasblocks, etc
                        if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id) && this.databaseService.getTemplates().items[item._tpl]._props.Slots[slotsIndex]._required === false) {
                            returnObj.DeleteItem.push(itemInInventory._id);
                            break;
                        }
                    }
                }
            } else if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
                returnObj.DeleteItem.push(itemInInventory._id);
            }
			
            // if item can have slots and is insured, call this function again
            if (this.databaseService.getTemplates().items[itemInInventory._tpl]._props.Slots.length != 0 && insuredItems.includes(itemInInventory._id)) {
                returnObj = this.handleEquippedGuns(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, returnObj);
            }
			
        }
		
        return returnObj;
    }

    public removeInsuredItems(insuredItemsList: InsuredItem[], itemsToRemove: string[]): InsuredItem[] {
        const returnList = insuredItemsList.filter(entry => !itemsToRemove.includes(entry.itemId));
		
        return returnList;
    }

    private isRequiredArmorPlate(item: Item, parent: Item): boolean {
        if (!item.slotId) return false;

        const itemTemplates = this.databaseService.getTables().templates.items;

        const parentTemplate = itemTemplates[parent._tpl];

        // Check to see if the slot that the item is attached to is marked as required in the parent item's template.
        let isRequiredSlot = false;
        if (parentTemplate && parentTemplate._props?.Slots) {
            isRequiredSlot = parentTemplate._props.Slots.some(slot => slot._name === item.slotId && slot._required);
        }
        return isRequiredSlot;
    }
}