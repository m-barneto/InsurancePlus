"use strict";

class Mod {
	// container to use outside pre-, post- loads
	static container;
	
	preAkiLoad(container) {
		// safe this reference to use instead of normal container
		Mod.container = container;
		
		// do the good old swaperoo
		container.afterResolution("InraidController", (_t, result) => {
			result.savePmcProgress = (sessionID, offraidData) => {
				return Mod.customSavePmc(sessionID, offraidData)
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
	
	static customSavePmc(sessionID, offraidData)
	{
		// resolve original container
		const inraidController = Mod.container.resolve("InraidController");
		
		// love me some logging
		const logger = Mod.container.resolve("WinstonLogger");
		
		const currentProfile = inraidController.saveServer.getProfile(sessionID);
		const locationName = currentProfile.inraid.location.toLowerCase();

		const map = inraidController.databaseServer.getTables().locations[locationName].base;
		const insuranceEnabled = map.Insurance;
		let pmcData = currentProfile.characters.pmc;
		const isDead = inraidController.isPlayerDead(offraidData.exit);
		const preRaidGear = inraidController.inRaidHelper.getPlayerGear(pmcData.Inventory.items);
		const preRaidInsuredItems = JSON.parse(JSON.stringify(pmcData.InsuredItems));

		currentProfile.inraid.character = "pmc";

		pmcData = inraidController.inRaidHelper.updateProfileBaseStats(pmcData, offraidData, sessionID);

		// Check for exit status
		inraidController.markOrRemoveFoundInRaidItems(offraidData, pmcData, false);

		offraidData.profile.Inventory.items = inraidController.itemHelper.replaceIDs(offraidData.profile, offraidData.profile.Inventory.items, pmcData.InsuredItems, offraidData.profile.Inventory.fastPanel);
		inraidController.inRaidHelper.addUpdToMoneyFromRaid(offraidData.profile.Inventory.items);

		pmcData = inraidController.inRaidHelper.setInventory(sessionID, pmcData, offraidData.profile);
		inraidController.healthHelper.saveVitality(pmcData, offraidData.health, sessionID);

		// remove inventory if player died and send insurance items
		if (isDead)
		{
			pmcData = Mod.customPostDeath(offraidData, pmcData, insuranceEnabled, preRaidGear, sessionID, logger);
		}
		
		// save post raid gear after you're done with deleting non insured items
		const postRaidGear = pmcData.Inventory.items;
		
		if (insuranceEnabled)
		{
			Mod.customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, logger);
		}

		if (insuranceEnabled)
		{
			inraidController.insuranceService.sendInsuredItems(pmcData, sessionID, map.Id);
		}
	}
	
	static customPostDeath(postRaidSaveRequest, pmcData, insuranceEnabled, preRaidGear, sessionID, logger) 
	{
		// resolve og container
		const inraidController = Mod.container.resolve("InraidController");
		
		inraidController.updatePmcHealthPostRaid(postRaidSaveRequest, pmcData);

		// since you don't lose anything, we don't need this anymore
		/*
		if (insuranceEnabled)
		{
			this.insuranceService.storeInsuredItemsForReturn(pmcData, postRaidSaveRequest, preRaidGear, sessionID);
		}
		*/
		
		pmcData = Mod.customDeleteInv(pmcData, sessionID, logger);
		
		//logger.info("so dead, very wow")

		for (const questItem of postRaidSaveRequest.profile.Stats.CarriedQuestItems)
		{
			const findItemConditionId = inraidController.questHelper.getFindItemIdForQuestHandIn(questItem);
			inraidController.profileHelper.resetProfileQuestCondition(sessionID, findItemConditionId);
		}

		pmcData.Stats.CarriedQuestItems = [];

		return pmcData;
	}
	
	static customDeleteInv(pmcData, sessionID, logger) 
	{
		// resolve required containers, yada yada
		const inRaidHelper = Mod.container.resolve("InRaidHelper");
		const database = Mod.container.resolve("DatabaseServer").getTables();
		
		//logger.info("yeah it works chief")
		
		const toDelete = [];
		const returnToDeleteGear = [];
		const returnToDeleteWeap = [];
		const insuredItems = [];
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
			"5447b5fc4bdc2d87278b4567"	// Assault Carbines
		];
		
		// dump all insured items in a simple array
		for (const insItem of pmcData.InsuredItems) {
			insuredItems.push(insItem.itemId);
		}

		for (const item of pmcData.Inventory.items) {
			
			// Remove uniinsured gear items only or quest raid items
			if (item.parentId === pmcData.Inventory.equipment) {
				if (!inRaidHelper.isItemKeptAfterDeath(item.slotId) && !insuredItems.includes(item._id) || item.parentId === pmcData.Inventory.questRaidItems) {
					toDelete.push(item._id);
				}
				
				// Remove items inside gear items
				if (item.slotId != "hideout" 
				&& item.slotId != "FirstPrimaryWeapon"
				&& item.slotId != "SecondPrimaryWeapon" 
				&& item.slotId != "Holster" 
				&& !inRaidHelper.isItemKeptAfterDeath(item.slotId)) {
					toDelete.push(...Mod.handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnToDeleteGear, logger));
				}
				
				// handle equipped guns, since we don't want want the become unoperable in player hands
				if (item.slotId === "FirstPrimaryWeapon" 
				|| item.slotId === "SecondPrimaryWeapon" 
				|| item.slotId === "Holster" ) {
					toDelete.push(...Mod.handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnToDeleteWeap, logger));
				}
			}
		}
		
		//logger.info(toDelete)

		// delete items
		for (const item of toDelete) {
			inRaidHelper.inventoryHelper.removeItem(pmcData, item, sessionID);
		}

		pmcData.Inventory.fastPanel = {};

		return pmcData;
	}
	
	static customStoreLostGear(pmcData, postRaidGear, preRaidGear, preRaidInsuredItems, sessionID, logger)
	{
		// resolve required container, yada yada
		const insuranceService = Mod.container.resolve("InsuranceService");
		
		const preRaidGearHash = {};
		const offRaidGearHash = {};
		const gears = [];

		// Build a hash table to reduce loops
		for (const item of preRaidGear) {
			preRaidGearHash[item._id] = item;
		}

		// Build a hash of offRaidGear
		for (const item of postRaidGear) {
			offRaidGearHash[item._id] = item;
		}

		for (const insuredItem of preRaidInsuredItems) {
			
			if (preRaidGearHash[insuredItem.itemId]) {
				// This item exists in preRaidGear, meaning we brought it into the raid...
				// Check if we brought it out of the raid
				if (!offRaidGearHash[insuredItem.itemId]) {
					// We didn't bring this item out! We must've lost it.
					gears.push({
						"pmcData": pmcData,
						"insuredItem": insuredItem,
						"item": preRaidGearHash[insuredItem.itemId],
						"sessionID": sessionID
					});
				}
			}
		}

		for (const gear of gears) {
			insuranceService.addGearToSend(gear.pmcData, gear.insuredItem, gear.item, gear.sessionID);
		}
	}
	
	static handleInventoryItems(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnToDeleteGear, logger)
	{
		
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			// Don't delete items in special slots
			// also skip insured items
			if (!itemInInventory.slotId.includes("SpecialSlot")) {
				if (!insuredItems.includes(itemInInventory._id) 
				&& !returnToDeleteGear.includes(itemInInventory._id)) {
					returnToDeleteGear.push(itemInInventory._id);
				} else if (dbParentIdsToCheck.includes(database.templates.items[itemInInventory._tpl]._parent)) {
					Mod.handleInventoryItems(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnToDeleteGear, logger);
				}
			}
		}
		
		return returnToDeleteGear;
	}
	
	
	// TO-DO
	// this goes through bunch of useless loops, find where and remove
	static handleEquippedGuns(pmcData, item, insuredItems, dbParentIdsToCheck, database, returnToDeleteWeap, logger)
	{
		for (const itemInInventory of pmcData.Inventory.items.filter(x => x.parentId == item._id)) {
			
			// skip if its ammo, we want to keep it
			if (database.templates.items[itemInInventory._tpl]._parent === "5485a8684bdc2da71d8b4567") {
				continue;
			}
			
			if (database.templates.items[item._tpl]._props.Slots.length != 0) {
				for (const slotsIndex in database.templates.items[item._tpl]._props.Slots) {
					if (database.templates.items[item._tpl]._props.Slots[slotsIndex]._props.filters[0].Filter.includes(itemInInventory._tpl)) {
						
						// check if the item is required, like pistol grips, gasblocks, etc
						if (!insuredItems.includes(itemInInventory._id) 
						&& !returnToDeleteWeap.includes(itemInInventory._id) 
						&& database.templates.items[item._tpl]._props.Slots[slotsIndex]._required === false) {
							returnToDeleteWeap.push(itemInInventory._id);
							break;
						}
					}
				}
			} else if (!insuredItems.includes(itemInInventory._id) 
			&& !returnToDeleteWeap.includes(itemInInventory._id)) {
				returnToDeleteWeap.push(itemInInventory._id);
			}
			
			// if item can have slots and is insured, call this function again
			if (database.templates.items[itemInInventory._tpl]._props.Slots.length != 0 && insuredItems.includes(itemInInventory._id)) {
				Mod.handleEquippedGuns(pmcData, itemInInventory, insuredItems, dbParentIdsToCheck, database, returnToDeleteWeap, logger)
			}
			
		}
		
		return returnToDeleteWeap;
	}
	
}

	
module.exports = { mod: new Mod() }