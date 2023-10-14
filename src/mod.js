"use strict";

class Mod {
	// container to use outside pre-, post- loads
	static container;
	
	preAkiLoad(container) {
		// safe this reference to use instead of normal container
		Mod.container = container;
		
		// do the good old swaperoo
		container.afterResolution("InraidController", (_t, result) => {
			result.savePmcProgress = (sessionID, postRaidRequest) => {
				return Mod.customSavePmc(sessionID, postRaidRequest)
			}
		}, {frequency: "Always"});
	}
	
	postDBLoad(container) {
		// constants
		const logger = container.resolve("WinstonLogger");
		const database = container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		const viableMaps = ["bigmap", "factory4_day", "factory4_night", "interchange", "lighthouse", "rezervbase", "shoreline", "woods"];
		
		// if default insurance is turned off, make it false in map files
		// dont handle labs, base game already has it at false
		if (!config.EnableDefaultInsurance) {
			for (const map in database.locations) {
				if (viableMaps.includes(map)) {
					database.locations[map].base.Insurance = false;
				}
			}
		}
	}
	
	static customSavePmc(sessionID, postRaidRequest) {
		// resolve original container
		const inraidController = Mod.container.resolve("InraidController");
		
		const serverProfile = inraidController.saveServer.getProfile(sessionID);
		const locationName = serverProfile.inraid.location.toLowerCase();
		const config = require("../config/config.json");

		const map = inraidController.databaseServer.getTables().locations[locationName].base;
		const mapHasInsuranceEnabled = map.Insurance;

		let serverPmcData = serverProfile.characters.pmc
		const isDead = inraidController.isPlayerDead(postRaidRequest.exit);
		const preRaidGear = inraidController.inRaidHelper.getPlayerGear(serverPmcData.Inventory.items);
		const preRaidInsuredItems = JSON.parse(JSON.stringify(serverPmcData.InsuredItems));

		serverProfile.inraid.character = "pmc";

		serverPmcData = inraidController.inRaidHelper.updateProfileBaseStats(serverPmcData, postRaidRequest, sessionID);

		// Check for exit status
		inraidController.markOrRemoveFoundInRaidItems(postRaidRequest);

		postRaidRequest.profile.Inventory.items = inraidController.itemHelper.replaceIDs(postRaidRequest.profile, postRaidRequest.profile.Inventory.items, serverPmcData.InsuredItems, postRaidRequest.profile.Inventory.fastPanel);
		inraidController.inRaidHelper.addUpdToMoneyFromRaid(postRaidRequest.profile.Inventory.items);

		// Purge profile of equipment/container items
		serverPmcData = inraidController.inRaidHelper.setInventory(sessionID, serverPmcData, postRaidRequest.profile);
		
		inraidController.healthHelper.saveVitality(serverPmcData, postRaidRequest.health, sessionID);
		
		// Edge case - Handle usec players leaving lighthouse with Rogues angry at them
        if (locationName === "lighthouse" && postRaidRequest.profile.Info.Side.toLowerCase() === "usec")
        {
            // Decrement counter if it exists, don't go below 0
            const remainingCounter = serverPmcData?.Stats.Eft.OverallCounters.Items.find(x => x.Key.includes("UsecRaidRemainKills"));
            if (remainingCounter?.Value > 0)
            {
                remainingCounter.Value --;
            }
        }

		// remove inventory if player died and send insurance items
		if (isDead) {
			inraidController.pmcChatResponseService.sendKillerResponse(sessionID, serverPmcData, postRaidRequest.profile.Stats.Eft.Aggressor);
            inraidController.matchBotDetailsCacheService.clearCache();
			
			serverPmcData = Mod.customPostDeath(postRaidRequest, serverPmcData, mapHasInsuranceEnabled, preRaidGear, sessionID);
		}
		
		const victims = postRaidRequest.profile.Stats.Eft.Victims.filter(x => ["sptbear", "sptusec"].includes(x.Role.toLowerCase()));
        if (victims?.length > 0) {
            inraidController.pmcChatResponseService.sendVictimResponse(sessionID, victims, serverPmcData);
        }
		
		// save post raid gear after you're done with deleting non insured items
		const postRaidGear = serverPmcData.Inventory.items;
		
		
		if (config.EnableDefaultInsurance) {
			if (mapHasInsuranceEnabled) {
				Mod.customStoreLostGear(serverPmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, isDead, postRaidRequest);
				inraidController.insuranceService.sendInsuredItems(serverPmcData, sessionID, map.Id);
			} else {
				inraidController.insuranceService.sendLostInsuranceMessage(sessionID);
			}
		}
	}
	
	static customPostDeath(postRaidSaveRequest, pmcData, insuranceEnabled, preRaidGear, sessionID) {
		// resolve og container
		const inraidController = Mod.container.resolve("InraidController");
		const QuestStatus = require("C:/snapshot/project/obj/models/enums/QuestStatus");
		
		inraidController.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);		
		pmcData = Mod.customDeleteInv(pmcData, sessionID);

		// Remove quest items
        if (inraidController.inRaidHelper.removeQuestItemsOnDeath()) {
            // Find and remove the completed condition from profile if player died, otherwise quest is stuck in limbo and quest items cannot be picked up again
            const allQuests = inraidController.questHelper.getQuestsFromDb();
            const activeQuestIdsInProfile = pmcData.Quests.filter(x => ![QuestStatus.AvailableForStart, QuestStatus.Success, QuestStatus.Expired].includes(x.status)).map(x => x.qid);
            for (const questItem of postRaidSaveRequest.profile.Stats.Eft.CarriedQuestItems)
            {
                // Get quest/find condition for carried quest item
                const questAndFindItemConditionId = inraidController.questHelper.getFindItemConditionByQuestItem(questItem, activeQuestIdsInProfile, allQuests);
                if (questAndFindItemConditionId)
                {
                    inraidController.profileHelper.removeCompletedQuestConditionFromProfile(pmcData, questAndFindItemConditionId);
                }
            }

            // Empty out stored quest items from player inventory
            pmcData.Stats.Eft.CarriedQuestItems = [];
        }


		return pmcData;
	}
	
	static customDeleteInv(pmcData, sessionID) {
		// resolve required containers, yada yada
		const inRaidHelper = Mod.container.resolve("InRaidHelper");
		const logger = Mod.container.resolve("WinstonLogger");
		const database = Mod.container.resolve("DatabaseServer").getTables();
		const config = require("../config/config.json");
		
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
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// push uninsured item to delete array
				if (!inRaidHelper.isItemKeptAfterDeath(pmcData, item) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
					deleteObj.DeleteItem.push(item._id);
				}
				
				// Remove items inside gear items
				if (item.slotId != "hideout" && item.slotId != "FirstPrimaryWeapon" && item.slotId != "SecondPrimaryWeapon" && item.slotId != "Holster" && !inRaidHelper.isItemKeptAfterDeath(pmcData, item)) {
					deleteObj = Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
				
				// handle equipped guns, since we don't want want them becoming unoperable in player hands
				if (item.slotId === "FirstPrimaryWeapon" || item.slotId === "SecondPrimaryWeapon" || item.slotId === "Holster") {
					deleteObj = Mod.handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, deleteObj);
				}
			}
		}
		
		// remove insurance from equipped items
		if (config.LoseInsuranceOnItemAfterDeath) {
			pmcData.InsuredItems = Mod.removeInsurance(pmcData.InsuredItems, deleteObj.DeleteInsurance)
		}

		// delete items
		for (const item of deleteObj.DeleteItem) {
			inRaidHelper.inventoryHelper.removeItem(pmcData, item, sessionID);
		}

		pmcData.Inventory.fastPanel = {};

		return pmcData;
	}
	
	static customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, playerDied, postRaidRequest) {
		// resolve required container, yada yada
		const insuranceService = Mod.container.resolve("InsuranceService");
		
		const preRaidGearHash = insuranceService.createItemHashTable(preRaidGear);
		const offRaidGearHash = insuranceService.createItemHashTable(postRaidGear);
		
		const equipmentToSendToPlayer = [];

		for (const insuredItem of preRaidInsuredItems) {
			
			// Skip insured items not on player when they started raid
            const preRaidItem = preRaidGearHash[insuredItem.itemId];
            if (!preRaidItem)
            {
                continue;
            }
			
			// Skip items we should never return
            if (insuranceService.insuranceConfig.blacklistedEquipment.includes(preRaidItem.slotId))
            {
                continue;
            }
			
			if (preRaidGearHash[insuredItem.itemId]) {
				// This item exists in preRaidGear, meaning we brought it into the raid...
				// Check if we brought it out of the raid
				if (!offRaidGearHash[insuredItem.itemId] /*|| playerDied*/) {
					// We didn't bring this item out! We must've lost it.
					equipmentToSendToPlayer.push({
						pmcData: pmcData,
						itemToReturnToPlayer: insuranceService.getInsuredItemDetails(pmcData, preRaidItem, postRaidRequest.insurance?.find(x => x.id === insuredItem.itemId)),
						traderId: insuredItem.tid,
						sessionID: sessionID
					});
				}
			}
		}

		for (const gear of equipmentToSendToPlayer) {
			insuranceService.addGearToSend(gear);
		}
	}
	
	static handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			// Don't delete items in special slots
			// also skip insured items
			if (!itemInInventory.slotId.includes("SpecialSlot")) {
				
				// add equipped insured items to an insurance delete array
				if (insuredItems.includes(itemInInventory._id)) {
					returnObj.DeleteInsurance.push(itemInInventory._id);
				}
				
				if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
					returnObj.DeleteItem.push(itemInInventory._id);
				} else if (dbParentIdsToCheck.includes(database.templates.items[itemInInventory._tpl]._parent)) {
					returnObj = Mod.handleInventoryItems(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
				}
			}
		}
		
		return returnObj;
	}
	
	
	// TO-DO
	// this goes through bunch of useless loops, find where and remove
	static handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnObj) {
		const logger = Mod.container.resolve("WinstonLogger");
		
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			
			
			
			// skip if its ammo, we want to keep it
			if (database.templates.items[itemInInventory._tpl]._parent === "5485a8684bdc2da71d8b4567") {
				continue;
			}
			
			// add to insured array if insured
			if (insuredItems.includes(itemInInventory._id)) {
				returnObj.DeleteInsurance.push(itemInInventory._id);
			}
			
			if (database.templates.items[item._tpl]._props.Slots.length != 0) {
				for (const slotsIndex in database.templates.items[item._tpl]._props.Slots) {
					if (database.templates.items[item._tpl]._props.Slots[slotsIndex]._props.filters[0].Filter.includes(itemInInventory._tpl)) {
						
						// check if the item is required, like pistol grips, gasblocks, etc
						if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id) && database.templates.items[item._tpl]._props.Slots[slotsIndex]._required === false) {
							returnObj.DeleteItem.push(itemInInventory._id);
							break;
						}
					}
				}
			} else if (!insuredItems.includes(itemInInventory._id) && !returnObj.DeleteItem.includes(itemInInventory._id)) {
				returnObj.DeleteItem.push(itemInInventory._id);
			}
			
			// if item can have slots and is insured, call this function again
			if (database.templates.items[itemInInventory._tpl]._props.Slots.length != 0 && insuredItems.includes(itemInInventory._id)) {
				returnObj = Mod.handleEquippedGuns(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnObj)
			}
			
		}
		
		return returnObj;
	}
	
	static removeInsurance(insuredItemsList, itemsToRemove) {
		const returnList = insuredItemsList.filter(entry => !itemsToRemove.includes(entry.itemId));
		
		return returnList;
	}
	
}

	
module.exports = { mod: new Mod() }