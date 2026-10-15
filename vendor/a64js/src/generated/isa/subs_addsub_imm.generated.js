export const ENCODINGS = [
    {
        "instructionId": "SUBS_addsub_imm",
        "encodingId": "SUBS_32S_addsub_imm",
        "mnemonic": "SUBS",
        "className": "Setting the condition flags",
        "fileName": "subs_addsub_imm.xml",
        "mask": 4286578688,
        "value": 1895825408,
        "bitCount": 9,
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
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
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
        "operandFamilyId": "add-sub-immediate"
    },
    {
        "instructionId": "SUBS_addsub_imm",
        "encodingId": "SUBS_64S_addsub_imm",
        "mnemonic": "SUBS",
        "className": "Setting the condition flags",
        "fileName": "subs_addsub_imm.xml",
        "mask": 4286578688,
        "value": 4043309056,
        "bitCount": 9,
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
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
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
        "operandFamilyId": "add-sub-immediate"
    }
];
