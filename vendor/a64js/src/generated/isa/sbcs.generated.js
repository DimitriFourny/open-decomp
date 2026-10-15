export const ENCODINGS = [
    {
        "instructionId": "SBCS",
        "encodingId": "SBCS_32_addsub_carry",
        "mnemonic": "SBCS",
        "className": "Setting the condition flags",
        "fileName": "sbcs.xml",
        "mask": 4292934656,
        "value": 2046820352,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    },
    {
        "instructionId": "SBCS",
        "encodingId": "SBCS_64_addsub_carry",
        "mnemonic": "SBCS",
        "className": "Setting the condition flags",
        "fileName": "sbcs.xml",
        "mask": 4292934656,
        "value": 4194304000,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "gp-rd-rn-rm-sf",
        "operandSchemaId": "gp-rd-rn-rm-sf"
    }
];
